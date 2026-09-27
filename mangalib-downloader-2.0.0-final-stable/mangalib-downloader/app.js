'use strict';

const { detectSite, parseSlug, readTarget, joinUrl, sanitize, padNum, guessExt, buildZip } = MLD;

// ---- Настройки ----
const API = 'https://api.cdnlibs.org/api';
const SITE_ID_FALLBACKS = { hentai: ['3'], manga: ['1'], slash: ['2'] };
const IMAGE_CONCURRENCY = 4; // страниц скачивается одновременно
const CHAPTER_PAUSE_MS = 300; // пауза между главами, чтобы не ловить 429
const FALLBACK_IMAGE_SERVERS = ['https://img2.imglib.info'];

// ---- Утилиты ----
const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoff = (attempt) => Math.min(1000 * 2 ** attempt, 15000);

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

const state = {
  slug: null,
  title: '',
  site: MLD.SITES.manga,
  origin: 'https://mangalib.me',
  chapters: [],
  rows: [],
  groups: [],
  lastIndex: null,
  running: false,
  ctrl: null,
  activeTabId: null,
};

const SOURCE_TAB_ID = (() => {
  const raw = new URLSearchParams(location.search).get('tabId');
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : null;
})();
if (SOURCE_TAB_ID != null) state.activeTabId = SOURCE_TAB_ID;

// ---- Работа с API ----
async function getActiveTabId() {
  if (state.activeTabId != null) return state.activeTabId;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || tab.id == null) throw new Error('Не удалось определить вкладку-источник. Откройте тайтл на сайте и запустите расширение с этой страницы.');
  state.activeTabId = tab.id;
  return tab.id;
}

async function pageFetchJson(url, headers) {
  const tabId = await getActiveTabId();
  try {
    const tab = await chrome.tabs.get(tabId);
    const host = tab && tab.url ? new URL(tab.url).hostname : '';
    if (!/(^|\.)hentailib\.(me|org)$/i.test(host)) {
      throw new Error('Для HentaiLib откройте саму страницу HentaiLib и запустите расширение от неё.');
    }
  } catch (err) {
    if (err && err.message && err.message.includes('Для HentaiLib')) throw err;
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (requestUrl, requestHeaders) => {
      const r = await fetch(requestUrl, {
        credentials: 'include',
        headers: requestHeaders,
        cache: 'no-store'
      });
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch (_) {}
      return { ok: r.ok, status: r.status, text: text.slice(0, 2000), data };
    },
    args: [url, headers || {}],
  });
  const result = results && results[0] && results[0].result;
  if (!result) throw new Error('Не удалось выполнить запрос в контексте страницы HentaiLib.');
  if (!result.ok) throw new HttpError(result.status);
  if (!result.data) throw new Error('API вернул не JSON.');
  return result.data;
}

async function apiGet(path) {
  const maxRetries = 5;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      if (state.site.key === 'hentai') return await pageFetchJson(API + path, { Accept: 'application/json', 'Site-Id': '3' });
      res = await fetch(API + path, {
        credentials: 'include',
        headers: { Accept: 'application/json', 'Site-Id': state.site.id }
      });
    } catch (_) {
      if (attempt >= maxRetries) throw new Error('Нет соединения с api.cdnlibs.org. Проверьте интернет или VPN.');
      await sleep(backoff(attempt));
      continue;
    }
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxRetries) {
      const wait = Number(res.headers.get('Retry-After'));
      await sleep(wait > 0 ? Math.min(wait, 60) * 1000 : backoff(attempt));
      continue;
    }
    throw new HttpError(res.status);
  }
}

function errorText(err) {
  if (err instanceof HttpError) {
    if (err.status === 404) return `API вернул 404 (Site-Id: ${state.site.id}). Для HentaiLib расширение автоматически пробует запасные Site-Id; если все дали 404, проверьте URL тайтла и откройте его в браузере.`;
    if (err.status === 401 || err.status === 403) return 'Доступ закрыт: глава платная, скрыта или требует входа на сайте.';
    if (err.status === 429) return 'Сайт ограничил частоту запросов. Подождите минуту и повторите.';
    return `Сайт ответил ошибкой ${err.status}.`;
  }
  return err && err.message ? err.message : String(err);
}

// Актуальный Site-Id сайта лежит в <html data-id="…"> его главной страницы.
// Если прочитать не удалось — берём запасное значение из lib.js.
async function resolveSiteId(site) {
  if (site.key === 'hentai') return '3';
  try {
    const res = await fetch(site.origin + '/', { credentials: 'include' });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/<html[^>]*\sdata-id=["'](\d+)["']/i);
      if (m) return m[1];
    }
  } catch (_) {
    /* используем запасной id */
  }
  return site.id;
}

async function getImageServers() {
  try {
    const json = await apiGet('/constants?fields[]=imageServers');
    const list = (json.data && json.data.imageServers) || [];
    const order = ['main', 'secondary', 'download', 'compress'];
    const rank = (s) => {
      const i = order.indexOf(s.id);
      return i === -1 ? order.length : i;
    };
    const urls = list
      .filter((s) => s && s.url && (!Array.isArray(s.site_ids) || s.site_ids.includes(Number(state.site.id))))
      .sort((a, b) => rank(a) - rank(b))
      .map((s) => s.url.replace(/\/+$/, ''));
    return urls.length ? [...new Set(urls)] : FALLBACK_IMAGE_SERVERS;
  } catch (_) {
    return FALLBACK_IMAGE_SERVERS;
  }
}

// ---- Разрешения и заголовки ----
async function ensureAccess(servers) {
  const origins = [...new Set(servers.map((s) => new URL(s).origin + '/*'))];
  if (await chrome.permissions.contains({ origins })) return;
  const granted = await chrome.permissions.request({ origins });
  if (!granted) throw new Error('Нужно разрешить доступ к серверу картинок: ' + origins.join(', '));
}

// Сервер картинок может проверять Referer — подставляем адрес сайта.
async function applyReferer(servers) {
  try {
    const hosts = [...new Set(servers.map((s) => new URL(s).hostname))];
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'referer', operation: 'set', value: state.origin + '/' }],
          },
          condition: { requestDomains: hosts, resourceTypes: ['xmlhttprequest'] },
        },
      ],
    });
  } catch (err) {
    console.warn('Не удалось задать Referer:', err);
  }
}

// ---- Интерфейс: статус и список ----
function setStatus(text, kind) {
  const el = $('#status');
  el.textContent = text || '';
  el.className = kind === 'error' ? 'error' : '';
}

function branchLabel(branch) {
  const teams = (branch.teams || []).map((t) => t.name).filter(Boolean).join(', ');
  return teams || (branch.user && branch.user.username) || 'Без команды';
}

function fillBranches(list) {
  const counts = new Map();
  for (const ch of list) {
    for (const b of ch.branches || []) {
      if (b.branch_id == null) continue;
      const entry = counts.get(b.branch_id) || { id: b.branch_id, label: branchLabel(b), count: 0 };
      entry.count++;
      counts.set(b.branch_id, entry);
    }
  }
  const branches = [...counts.values()].sort((a, b) => b.count - a.count);
  const select = $('#branch');
  select.replaceChildren(
    ...branches.map((b) => {
      const opt = document.createElement('option');
      opt.value = String(b.id);
      opt.textContent = `${b.label} — ${b.count} гл.`;
      return opt;
    })
  );
  $('#branch-wrap').hidden = branches.length < 2;
}

function pickBranch(ch) {
  const own = (ch.branches || []).map((b) => b.branch_id).filter((v) => v != null);
  const chosen = $('#branch').value;
  if (chosen && own.map(String).includes(chosen)) return chosen;
  return own.length ? String(own[0]) : null;
}

function makeCheckbox() {
  const input = document.createElement('input');
  input.type = 'checkbox';
  return input;
}

function renderChapters(target) {
  const root = $('#chapters');
  root.replaceChildren();
  state.rows = [];
  state.groups = [];
  state.lastIndex = null;

  let volume = null;
  let group = null;

  for (const ch of state.chapters) {
    if (!group || ch.volume !== volume) {
      volume = ch.volume;
      group = makeGroup(volume);
      state.groups.push(group);
      root.append(group.el);
    }
    const row = makeRow(ch, state.rows.length);
    group.rows.push(row);
    group.body.append(row.el);
    state.rows.push(row);
  }

  for (const g of state.groups) {
    g.count.textContent = `${g.rows.length} гл.`;
  }

  if (target) {
    const hit = state.rows.find(
      (r) => String(r.ch.volume) === target.volume && String(r.ch.number) === target.number
    );
    if (hit) {
      hit.input.checked = true;
      hit.el.classList.add('flash');
      hit.el.scrollIntoView({ block: 'center' });
    }
  }
  updateSelected();
}

function makeGroup(volume) {
  const el = document.createElement('section');
  const head = document.createElement('label');
  head.className = 'vol-head';
  const input = makeCheckbox();
  const text = document.createElement('span');
  text.textContent = `Том ${volume}`;
  const count = document.createElement('span');
  count.className = 'muted';
  head.append(input, text, count);
  const body = document.createElement('div');
  el.append(head, body);

  const group = { el, body, input, count, rows: [] };
  input.addEventListener('change', () => {
    for (const r of group.rows) r.input.checked = input.checked;
    updateSelected();
  });
  return group;
}

function makeRow(ch, index) {
  const el = document.createElement('label');
  el.className = 'ch';
  const input = makeCheckbox();
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = ch.number;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = ch.name || '';
  const tag = document.createElement('span');
  tag.className = 'tag';
  if ((ch.branches || []).length > 1) tag.textContent = `переводов: ${ch.branches.length}`;
  el.append(input, num, name, tag);

  input.addEventListener('click', (e) => {
    if (e.shiftKey && state.lastIndex !== null) {
      const [from, to] = [state.lastIndex, index].sort((a, b) => a - b);
      for (let i = from; i <= to; i++) state.rows[i].input.checked = input.checked;
    }
    state.lastIndex = index;
    updateSelected();
  });
  return { el, input, ch };
}

function updateSelected() {
  const total = state.rows.filter((r) => r.input.checked).length;
  $('#selected').textContent = `Выбрано: ${total} из ${state.rows.length}`;
  $('#start').disabled = state.running || total === 0;
  for (const g of state.groups) {
    const checked = g.rows.filter((r) => r.input.checked).length;
    g.input.checked = checked === g.rows.length;
    g.input.indeterminate = checked > 0 && checked < g.rows.length;
  }
}

function setAll(value) {
  for (const r of state.rows) r.input.checked = value;
  updateSelected();
}

// ---- Загрузка списка глав ----
async function loadTitle(input) {
  const slug = parseSlug(input);
  if (!slug) {
    setStatus('Не нашёл тайтл в ссылке. Пример: https://mangalib.me/ru/manga/7580--название', 'error');
    return;
  }
  const site = detectSite(input);
  if (!site) {
    setStatus('Эта ссылка не с MangaLib, SlashLib или HentaiLib. Другие сайты не поддерживаются.', 'error');
    return;
  }
  $('#panel').hidden = true;
  $('#bar').hidden = true;
  $('#load-btn').disabled = true;
  setStatus(`Загружаю список глав (${site.name})…`);

  try {
    if (SOURCE_TAB_ID == null) state.activeTabId = null;
    site.id = await resolveSiteId(site);
    state.site = site;
    state.origin = site.origin;
    // HentaiLib historically used different Site-Id values on mirrors. If the
    // resolved value is wrong, a valid title is indistinguishable from a 404.
    // Try the known HentaiLib ids before reporting the title as missing.
    let chapters;
    let lastErr;
    const ids = [...new Set([state.site.id, ...(SITE_ID_FALLBACKS[state.site.key] || [])])];
    for (const id of ids) {
      state.site.id = String(id);
      try {
        chapters = await apiGet(`/manga/${encodeURIComponent(slug)}/chapters`);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!(err instanceof HttpError) || ![404, 401, 403].includes(err.status)) throw err;
      }
    }
    if (!chapters) throw lastErr || new HttpError(404);
    const info = await apiGet(`/manga/${encodeURIComponent(slug)}`).catch(() => null);
    const list = (chapters.data || []).slice();
    if (!list.length) {
      setStatus('У этого тайтла нет доступных глав.', 'error');
      return;
    }
    const num = (v) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);
    list.sort((a, b) => num(a.volume) - num(b.volume) || num(a.number) - num(b.number));

    const data = (info && info.data) || {};
    state.slug = slug;
    state.title = data.rus_name || data.name || data.eng_name || slug.replace(/^\d+--/, '');
    state.chapters = list;

    $('#title').textContent = state.title;
    $('#count').textContent = `${state.site.name}, ${list.length} гл.`;
    fillBranches(list);
    renderChapters(readTarget(input));
    $('#panel').hidden = false;
    $('#bar').hidden = false;
    $('#page-capture').hidden = state.site.key !== 'hentai';
    setStatus('');
  } catch (err) {
    setStatus(errorText(err), 'error');
  } finally {
    $('#load-btn').disabled = false;
  }
}

// ---- Скачивание ----
async function scanPageImageUrls() {
  const tabId = await getActiveTabId();
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const seen = new Set();
      const add = (u) => {
        if (!u || typeof u !== 'string') return;
        try {
          const x = new URL(u, location.href);
          if (x.protocol === 'http:' || x.protocol === 'https:') seen.add(x.href);
        } catch (_) {}
      };
      const collect = () => {
        for (const img of document.images) {
          if (img.naturalWidth < 200 && img.naturalHeight < 200) continue;
          add(img.currentSrc); add(img.src);
          for (const a of ['data-src','data-original','data-lazy-src','data-url','data-image']) add(img.getAttribute(a));
          const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
          if (srcset) for (const part of srcset.split(',')) add(part.trim().split(/\s+/)[0]);
        }
        for (const el of document.querySelectorAll('[style*="background-image"]')) {
          const m = (el.getAttribute('style') || '').match(/url\\(["']?([^"')]+)["']?\\)/i);
          if (m) add(m[1]);
        }
        for (const e of performance.getEntriesByType('resource')) {
          const u = e.name || '';
          if (/\\.(?:jpe?g|png|webp|avif|gif)(?:[?#]|$)/i.test(u) || /(?:image|img|chapter|page)/i.test(u)) add(u);
        }
      };
      const old = window.scrollY;
      const max = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
      const step = Math.max(300, Math.floor(innerHeight * 0.8));
      for (let y = 0; y <= max + step; y += step) {
        window.scrollTo(0, y);
        collect();
        await wait(120);
      }
      collect();
      window.scrollTo(0, old);
      return [...seen].filter(u => !/^data:/i.test(u));
    }
  });
  return (results && results[0] && results[0].result) || [];
}

async function pageFetchImagesBatch(urls, signal) {
  const tabId = await getActiveTabId();
  if (signal?.aborted) throw new DOMException('Остановлено', 'AbortError');
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (imageUrls) => {
      const out = [];
      for (const imageUrl of imageUrls) {
        try {
          const r = await fetch(imageUrl, { credentials: 'include', cache: 'no-store' });
          if (!r.ok) { out.push({ url: imageUrl, ok: false, status: r.status }); continue; }
          const buf = new Uint8Array(await r.arrayBuffer());
          let binary = '';
          const chunk = 0x8000;
          for (let i = 0; i < buf.length; i += chunk) binary += String.fromCharCode(...buf.subarray(i, Math.min(i + chunk, buf.length)));
          out.push({ url: imageUrl, ok: true, status: r.status, type: r.headers.get('content-type') || '', b64: btoa(binary) });
        } catch (e) { out.push({ url: imageUrl, ok: false, status: 0, error: String(e) }); }
      }
      return out;
    },
    args: [urls],
  });
  const raw = (results && results[0] && results[0].result) || [];
  return raw.map(r => {
    if (!r.ok) return r;
    const binary = atob(r.b64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    return { url: r.url, data, type: r.type };
  });
}

async function captureCurrentPage(signal) {
  if (state.site.key !== 'hentai') throw new Error('Захват изображений со страницы доступен для HentaiLib.');
  const urls = await scanPageImageUrls();
  if (!urls.length) throw new Error('На открытой странице не найдено загруженных изображений. Откройте страницу чтения и дождитесь загрузки страниц.');
  const files = [];
  for (let i = 0; i < urls.length; i += 3) {
    if (signal.aborted) throw new DOMException('Остановлено', 'AbortError');
    const batch = await pageFetchImagesBatch(urls.slice(i, i + 3), signal);
    for (const img of batch) {
      if (!img.ok && !img.data) continue;
      const ext = guessExt(img.url, img.type);
      files.push({ name: `${String(files.length + 1).padStart(4, '0')}.${ext}`, data: img.data, type: img.type, url: img.url });
    }
    setStatus(`Извлечено изображений: ${files.length} из найденных ${urls.length}…`);
  }
  if (!files.length) throw new Error('Изображения найдены, но браузер не разрешил их повторно получить в текущей сессии.');
  const unique = [];
  const seen = new Set();
  for (const f of files) {
    const key = f.url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }
  return unique;
}

async function saveCapturedFiles(files, format) {
  const title = sanitize(state.title || 'HentaiLib');
  const target = readTarget($('#url').value);
  const label = target ? `т${padNum(target.volume,2)} гл${padNum(target.number,4)}` : 'страница';
  const base = `HentaiLib/${title}/${title} - ${label} - extracted`;
  const jobs = [];
  if (format === 'cbz' || format === 'both') {
    const u = URL.createObjectURL(buildZip(files));
    jobs.push((async () => { try { await chrome.downloads.download({url:u, filename:`${base}.cbz`, conflictAction:'uniquify', saveAs:false}); } finally { setTimeout(()=>URL.revokeObjectURL(u), 300000); } })());
  }
  if (format === 'pdf' || format === 'both') {
    const pdf = await buildChapterPdf(files);
    const u = URL.createObjectURL(pdf);
    jobs.push((async () => { try { await chrome.downloads.download({url:u, filename:`${base}.pdf`, conflictAction:'uniquify', saveAs:false}); } finally { setTimeout(()=>URL.revokeObjectURL(u), 300000); } })());
  }
  await Promise.all(jobs);
}

async function pageFetchImage(url, signal) {
  const tabId = await getActiveTabId();
  if (signal && signal.aborted) throw new DOMException('Остановлено', 'AbortError');
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (imageUrl) => {
      const r = await fetch(imageUrl, { credentials: 'include', cache: 'no-store' });
      if (!r.ok) return { ok: false, status: r.status };
      const buf = new Uint8Array(await r.arrayBuffer());
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < buf.length; i += chunk) {
        binary += String.fromCharCode(...buf.subarray(i, Math.min(i + chunk, buf.length)));
      }
      return { ok: true, status: r.status, type: r.headers.get('content-type') || '', b64: btoa(binary) };
    },
    args: [url],
  });
  const result = results && results[0] && results[0].result;
  if (!result || !result.ok) throw new HttpError(result ? result.status : 0);
  const binary = atob(result.b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { url, data: bytes, type: result.type };
}

async function fetchImage(page, servers, signal) {
  const rel = page.url || page.image;
  if (!rel) throw new Error('У страницы нет адреса картинки');
  const candidates = /^https?:\/\//i.test(rel) ? [rel] : servers.map((s) => joinUrl(s, rel));
  let lastError = new Error('Не удалось скачать страницу');

  for (const url of candidates) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { signal, credentials: 'include' });
        if (res.ok) {
          return {
            url,
            data: new Uint8Array(await res.arrayBuffer()),
            type: res.headers.get('content-type'),
          };
        }
        lastError = new HttpError(res.status);
        if ((res.status === 401 || res.status === 403 || res.status === 404) && state.site.key === 'hentai') {
          try { return await pageFetchImage(url, signal); } catch (pageErr) { lastError = pageErr; }
        }
        if (res.status === 403 || res.status === 404) break; // пробуем другой сервер
        if (res.status === 429) await sleep(backoff(attempt + 1));
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastError = err;
      }
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastError;
}

async function runPool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

async function imageToJpeg(img) {
  // JPEG можно положить в PDF напрямую — это быстрее и заметно экономит память.
  const type = String(img.type || '').split(';')[0].toLowerCase();
  if (type === 'image/jpeg' || /\.jpe?g$/i.test(img.url.split(/[?#]/)[0])) {
    const blob = new Blob([img.data], { type: 'image/jpeg' });
    const bitmap = await createImageBitmap(blob);
    const result = { data: img.data, width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return result;
  }

  // Остальные форматы декодируем браузером и приводим к JPEG.
  const blob = new Blob([img.data], { type: type || 'application/octet-stream' });
  const bitmap = await createImageBitmap(blob);
  try {
    const maxSide = 12000;
    let width = bitmap.width;
    let height = bitmap.height;
    if (Math.max(width, height) > maxSide) {
      const scale = maxSide / Math.max(width, height);
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.drawImage(bitmap, 0, 0, width, height);
    const jpegBlob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error('Не удалось преобразовать изображение в JPEG.')), 'image/jpeg', 0.94);
    });
    return { data: new Uint8Array(await jpegBlob.arrayBuffer()), width, height };
  } finally {
    bitmap.close();
  }
}

async function buildChapterPdf(files) {
  const images = new Array(files.length);
  // Последовательно: так память не раздувается на больших главах.
  for (let i = 0; i < files.length; i++) images[i] = await imageToJpeg(files[i]);
  return MLDPdf.buildPdf(images);
}

async function downloadChapter(ch, servers, signal, onPage, format, imageSink) {
  const query = new URLSearchParams({ number: ch.number, volume: ch.volume });
  const branch = pickBranch(ch);
  if (branch) query.set('branch_id', branch);

  const json = await apiGet(`/manga/${encodeURIComponent(state.slug)}/chapter?${query}`);
  const pages = json.data && json.data.pages;
  if (!Array.isArray(pages) || !pages.length) {
    throw new Error('В главе нет страниц — возможно, она платная или закрыта.');
  }

  const width = Math.max(3, String(pages.length).length);
  const files = new Array(pages.length);
  const local = new AbortController();
  const forward = () => local.abort();
  signal.addEventListener('abort', forward);
  let done = 0;

  try {
    await runPool(pages, IMAGE_CONCURRENCY, async (page, i) => {
      const img = await fetchImage(page, servers, local.signal);
      const ext = guessExt(img.url, img.type);
      files[i] = { name: `${String(i + 1).padStart(width, '0')}.${ext}`, data: img.data, type: img.type, url: img.url };
      onPage(++done, pages.length);
    });
  } catch (err) {
    local.abort();
    throw err;
  } finally {
    signal.removeEventListener('abort', forward);
  }

  // При объединении добавляем изображения в общий список с папкой главы.
  if (imageSink) {
    const folder = `т${padNum(ch.volume, 2)} гл${padNum(ch.number, 4)}`;
    for (const f of files) imageSink.push({ ...f, name: `${folder}/${f.name}` });
    return;
  }

  const folder = sanitize(state.title);
  const base = `${state.site.name}/${folder}/${folder} - т${padNum(ch.volume, 2)} гл${padNum(ch.number, 4)}`;
  const jobs = [];

  if (format === 'cbz' || format === 'both') {
    const blobUrl = URL.createObjectURL(buildZip(files));
    jobs.push((async () => {
      try {
        await chrome.downloads.download({ url: blobUrl, filename: `${base}.cbz`, conflictAction: 'uniquify', saveAs: false });
      } finally { setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000); }
    })());
  }

  if (format === 'pdf' || format === 'both') {
    const pdfBlob = await buildChapterPdf(files);
    const blobUrl = URL.createObjectURL(pdfBlob);
    jobs.push((async () => {
      try {
        await chrome.downloads.download({ url: blobUrl, filename: `${base}.pdf`, conflictAction: 'uniquify', saveAs: false });
      } finally { setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000); }
    })());
  }
  await Promise.all(jobs);
}

async function downloadCombined(selected, servers, signal, format, onChapter, onPage) {
  const files = [];
  for (let i = 0; i < selected.length; i++) {
    if (signal.aborted) throw new DOMException('Остановлено', 'AbortError');
    const ch = selected[i];
    const label = `т${ch.volume} гл${ch.number}`;
    await downloadChapter(ch, servers, signal, (done, total) => onPage(i, selected.length, label, done, total), format, files);
    onChapter(i + 1, selected.length, label);
  }

  if (!files.length) throw new Error('Не удалось получить страницы выбранных глав.');

  const title = sanitize(state.title);
  const prefix = `${state.site.name}/${title}/${title} - ${selected.length} глав`;
  const jobs = [];

  if (format === 'cbz' || format === 'both') {
    const blobUrl = URL.createObjectURL(buildZip(files));
    jobs.push((async () => {
      try {
        await chrome.downloads.download({ url: blobUrl, filename: `${prefix}.cbz`, conflictAction: 'uniquify', saveAs: false });
      } finally { setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000); }
    })());
  }

  if (format === 'pdf' || format === 'both') {
    const pdfBlob = await buildChapterPdf(files);
    const blobUrl = URL.createObjectURL(pdfBlob);
    jobs.push((async () => {
      try {
        await chrome.downloads.download({ url: blobUrl, filename: `${prefix}.pdf`, conflictAction: 'uniquify', saveAs: false });
      } finally { setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000); }
    })());
  }
  await Promise.all(jobs);
}

function addLog(text, kind) {
  const li = document.createElement('li');
  li.textContent = text;
  if (kind) li.className = kind;
  const log = $('#log');
  log.append(li);
  log.scrollTop = log.scrollHeight;
}

function setRunning(running) {
  state.running = running;
  $('#stop').hidden = !running;
  $('#start').hidden = running;
  $('#load-btn').disabled = running;
  updateSelected();
}

async function startDownload() {
  const selected = state.rows.filter((r) => r.input.checked).map((r) => r.ch);
  if (!selected.length || state.running) return;
  const format = $('#format').value;
  const pack = $('#pack').value;

  const ctrl = new AbortController();
  state.ctrl = ctrl;
  setRunning(true);
  $('#progress').hidden = false;
  $('#log').replaceChildren();
  $('#overall').max = selected.length;
  $('#overall').value = 0;
  $('#current').textContent = 'Готовлюсь…';

  let ok = 0;
  let failed = 0;

  try {
    const servers = await getImageServers();
    await ensureAccess(servers);
    await applyReferer(servers);

    if (pack === 'single') {
      try {
        await downloadCombined(selected, servers, ctrl.signal, format,
          (done, total, label) => {
            $('#overall').value = done;
            $('#overall-text').textContent = `${done} из ${total}`;
            $('#current').textContent = `Глава: ${label}`;
          },
          (chapterIndex, total, label, pageDone, pageTotal) => {
            $('#overall').value = chapterIndex;
            $('#overall-text').textContent = `${chapterIndex} из ${total}`;
            $('#current').textContent = `Глава: ${label} — страница ${pageDone} из ${pageTotal}`;
          }
        );
        ok = selected.length;
        addLog(`Объединено в один файл: ${selected.length} глав (${format === 'both' ? 'CBZ + PDF' : format.toUpperCase()})`, 'ok');
      } catch (err) {
        if (!ctrl.signal.aborted) {
          failed = selected.length;
          addLog(`Объединённая загрузка: ${errorText(err)}`, 'err');
        }
      }
    } else {
      for (let i = 0; i < selected.length; i++) {
        if (ctrl.signal.aborted) break;
        const ch = selected[i];
        const label = `т${ch.volume} гл${ch.number}`;
        $('#overall-text').textContent = `${i + 1} из ${selected.length}`;
        $('#current').textContent = `Глава: ${label}`;
        try {
          await downloadChapter(ch, servers, ctrl.signal, (done, total) => {
            $('#current').textContent = `Глава: ${label} — страница ${done} из ${total}`;
          }, format, null);
          ok++;
          addLog(`${label}: сохранена (${format === 'both' ? 'CBZ + PDF' : format.toUpperCase()})`, 'ok');
        } catch (err) {
          if (ctrl.signal.aborted) break;
          failed++;
          addLog(`${label}: ${errorText(err)}`, 'err');
        }
        $('#overall').value = i + 1;
        await sleep(CHAPTER_PAUSE_MS);
      }
    }

    const stopped = ctrl.signal.aborted;
    $('#current').textContent = stopped ? 'Остановлено' : 'Готово';
    if (pack === 'chapter') {
      addLog(`${stopped ? 'Остановлено' : 'Завершено'}: сохранено ${ok}, с ошибками ${failed}. Файлы — в папке загрузок.`);
    }
  } catch (err) {
    $('#current').textContent = 'Не удалось начать';
    addLog(errorText(err), 'err');
  } finally {
    setRunning(false);
  }
}

async function startPageCapture() {
  if (state.running) return;
  const ctrl = new AbortController();
  state.ctrl = ctrl;
  setRunning(true);
  $('#progress').hidden = false;
  $('#log').replaceChildren();
  $('#current').textContent = 'Сканирую страницу чтения…';
  try {
    const files = await captureCurrentPage(ctrl.signal);
    $('#current').textContent = `Найдено полных изображений: ${files.length}`;
    await saveCapturedFiles(files, $('#format').value);
    addLog(`Извлечено и сохранено изображений: ${files.length} (${$('#format').value === 'both' ? 'CBZ + PDF' : $('#format').value.toUpperCase()})`, 'ok');
  } catch (err) {
    if (!ctrl.signal.aborted) addLog(`Захват страницы: ${errorText(err)}`, 'err');
  } finally {
    setRunning(false);
  }
}

// ---- Запуск ----
$('#load-form').addEventListener('submit', (e) => {
  e.preventDefault();
  loadTitle($('#url').value);
});
$('#sel-all').addEventListener('click', () => setAll(true));
$('#sel-none').addEventListener('click', () => setAll(false));
$('#start').addEventListener('click', startDownload);
$('#capture-start').addEventListener('click', startPageCapture);
$('#stop').addEventListener('click', () => state.ctrl && state.ctrl.abort());
window.addEventListener('beforeunload', (e) => {
  if (state.running) {
    e.preventDefault();
    e.returnValue = '';
  }
});

const initial = new URLSearchParams(location.search).get('u');
if (initial) {
  $('#url').value = initial;
  loadTitle(initial);
}
