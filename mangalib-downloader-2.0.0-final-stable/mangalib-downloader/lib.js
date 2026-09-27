// Чистые функции без обращения к сети и браузерным API — их удобно тестировать отдельно.
(function (root) {
  'use strict';

  const LOCALES = /^(ru|en|ja|ko|zh|es|de|fr|pt|it|tr|uk)$/i;

  // Сайты сети lib.social используют один API и различаются заголовком Site-Id.
  // id здесь — запасное значение; при загрузке расширение пробует прочитать актуальный
  // id из <html data-id="…"> главной страницы сайта.
  const SITES = {
    manga: { key: 'manga', name: 'MangaLib', id: '1', host: /(^|\.)mangalib\.(me|org)$/i, origin: 'https://mangalib.me' },
    slash: { key: 'slash', name: 'SlashLib', id: '2', host: /(^|\.)slashlib\.(me|org)$/i, origin: 'https://slashlib.me' },
    hentai: { key: 'hentai', name: 'HentaiLib', id: '3', host: /(^|\.)hentailib\.(me|org)$/i, origin: 'https://hentailib.me' },
  };

  // Ссылка → описание сайта. Не-ссылка (просто slug) считается MangaLib.
  // Ссылка на чужой сайт → null.
  function detectSite(input) {
    let url;
    try {
      url = new URL(String(input || '').trim());
    } catch (_) {
      return Object.assign({}, SITES.manga);
    }
    for (const site of Object.values(SITES)) {
      if (site.host.test(url.hostname)) return Object.assign({}, site, { origin: url.origin });
    }
    return null;
  }

  // Достаёт slug_url тайтла (вида "7580--название") из любой ссылки MangaLib.
  function parseSlug(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    let url;
    try {
      url = new URL(raw);
    } catch (_) {
      return /^[\w-]+$/.test(raw) ? raw : null;
    }
    const segs = url.pathname.split('/').filter(Boolean);
    const withId = segs.find((s) => /^\d+--/.test(s));
    if (withId) return withId;
    const i = segs.indexOf('manga');
    if (i >= 0 && segs[i + 1]) return segs[i + 1];
    const rest = segs.filter((s) => !LOCALES.test(s));
    return rest[0] || null;
  }

  // Ссылка вида .../read/v2/c15 → { volume: "2", number: "15" }.
  function readTarget(input) {
    const m = String(input || '').match(/\/read\/v([^/?#]+)\/c([^/?#]+)/i);
    return m ? { volume: decodeURIComponent(m[1]), number: decodeURIComponent(m[2]) } : null;
  }

  function joinUrl(base, rel) {
    if (/^https?:\/\//i.test(rel)) return rel;
    return String(base).replace(/\/+$/, '') + '/' + String(rel).replace(/^\/+/, '');
  }

  function sanitize(name, max) {
    const limit = max || 80;
    const s = String(name)
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '');
    return (s || 'manga').slice(0, limit).replace(/[.\s]+$/g, '') || 'manga';
  }

  // "5" → "0005", "12.5" → "0012.5" — чтобы файлы сортировались правильно.
  function padNum(value, width) {
    const parts = String(value).split('.');
    const head = /^\d+$/.test(parts[0]) ? parts[0].padStart(width, '0') : parts[0];
    return parts.length > 1 ? head + '.' + parts.slice(1).join('.') : head;
  }

  const CT_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/gif': 'gif',
  };

  function guessExt(url, contentType) {
    const m = String(url).split(/[?#]/)[0].match(/\.(jpe?g|png|webp|avif|gif)$/i);
    if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
    const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
    return CT_EXT[ct] || 'jpg';
  }

  // ---- ZIP (без сжатия: картинки и так сжаты) ----
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // files: [{ name: string, data: Uint8Array }] → Blob (.cbz / .zip)
  function buildZip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    const body = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const name = enc.encode(f.name);
      const size = f.data.length;
      const crc = crc32(f.data);

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true); // имена в UTF-8
      lh.setUint16(8, 0, true); // без сжатия
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);
      lh.setUint32(22, size, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);
      body.push(new Uint8Array(lh.buffer), name, f.data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true);
      ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);

      offset += 30 + name.length + size;
    }

    const centralSize = central.reduce((sum, p) => sum + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...body, ...central, new Uint8Array(end.buffer)], {
      type: 'application/vnd.comicbook+zip',
    });
  }

  const api = { SITES, detectSite, parseSlug, readTarget, joinUrl, sanitize, padNum, guessExt, crc32, buildZip };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MLD = api;
})(typeof self !== 'undefined' ? self : this);
