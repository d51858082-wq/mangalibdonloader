// Клик по иконке расширения открывает страницу загрузчика.
// Если активная вкладка — MangaLib, SlashLib или HentaiLib, её адрес подставляется автоматически.
chrome.action.onClicked.addListener((tab) => {
  const base = chrome.runtime.getURL('app.html');
  const onLibSite = tab && tab.url && /^https:\/\/([\w-]+\.)*(manga|slash|hentai)lib\.(me|org)\//i.test(tab.url);
  chrome.tabs.create({ url: onLibSite ? `${base}?u=${encodeURIComponent(tab.url)}&tabId=${encodeURIComponent(String(tab.id))}` : base });
});
