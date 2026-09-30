// 一键清除 (panic wipe). Loaded on every page of the site and on the 加密聊天 page.
//
// Any element with a data-panic attribute becomes a wipe button: the first press arms it
// (the label changes for 4 seconds), the second press wipes. Pressing Esc three times
// within 1.5 seconds wipes at once, without asking.
//
// A wipe removes everything this site keeps in the browser for the current address:
// localStorage, sessionStorage, IndexedDB (加密聊天 identity, 我的群, 事件墙 receipts),
// Cache Storage, service workers and cookies. The page then goes to /wipe (or /chat/wipe on
// the chat service), which answers with Clear-Site-Data so the browser also drops its HTTP
// cache for this address, and moves on to a neutral site.
//
// It cannot remove browser history, downloaded files, screenshots, or data kept under other
// addresses of this site (each mirror IP is a separate address); /safety says so.
(() => {
  'use strict';
  const NEUTRAL = 'https://www.bing.com/';
  let wiping = false;

  async function clearStorage() {
    const jobs = [];
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
    try {
      const names = new Set(['end-gfw-chat']);
      if (indexedDB.databases) {
        for (const db of await indexedDB.databases()) if (db && db.name) names.add(db.name);
      }
      for (const name of names) {
        jobs.push(new Promise((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        }));
      }
    } catch {}
    try {
      if (self.caches) for (const k of await caches.keys()) jobs.push(caches.delete(k));
    } catch {}
    try {
      if (navigator.serviceWorker) {
        for (const r of await navigator.serviceWorker.getRegistrations()) jobs.push(r.unregister());
      }
    } catch {}
    try {
      for (const c of document.cookie.split(';')) {
        const name = c.split('=')[0].trim();
        if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
      }
    } catch {}
    // Never wait long: getting off the page matters more than a slow delete
    await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, 1500))]);
  }

  async function wipe() {
    if (wiping) return;
    wiping = true;
    // Hide the page right away
    try {
      document.title = '';
      document.documentElement.style.background = '#fff';
      document.body.replaceChildren();
    } catch {}
    await clearStorage();
    const onChat = location.pathname === '/chat' || location.pathname.startsWith('/chat/');
    try {
      location.replace(onChat ? '/chat/wipe' : '/wipe');
    } catch {
      location.replace(NEUTRAL);
    }
  }

  function arm(btn) {
    if (btn.dataset.armed === '1') return wipe();
    const label = btn.textContent;
    btn.dataset.armed = '1';
    btn.textContent = '再点一次立即清除';
    btn.classList.add('panic-armed');
    setTimeout(() => {
      if (wiping) return;
      btn.dataset.armed = '';
      btn.textContent = label;
      btn.classList.remove('panic-armed');
    }, 4000);
  }

  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element && e.target.closest('[data-panic]');
    if (!btn) return;
    e.preventDefault();
    arm(btn);
  });

  let presses = [];
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const t = Date.now();
    presses = presses.filter((p) => t - p < 1500);
    presses.push(t);
    if (presses.length >= 3) wipe();
  }, true);

  // For other scripts (e.g. a button added later)
  window.endGfwWipe = wipe;
})();
