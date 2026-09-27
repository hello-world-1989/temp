// Google AdSense (auto ads) and Google's consent message, same account as the old site.
// Loaded on every page; skipped when developing locally.
(function () {
  var host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return;
  // Old-site pages served here load AdSense themselves on end-gfw.com
  if (document.querySelector('script[src*="adsbygoogle.js"]')) return;

  function add(src) {
    var s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    document.head.appendChild(s);
  }
  add('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7165471280882308');
  add('https://fundingchoicesmessages.google.com/i/pub-7165471280882308?ers=1');

  // Tells the consent script that this page supports it
  function signalGooglefcPresent() {
    if (window.frames['googlefcPresent']) return;
    if (!document.body) return setTimeout(signalGooglefcPresent, 0);
    var f = document.createElement('iframe');
    f.name = 'googlefcPresent';
    f.hidden = true;
    f.width = '0';
    f.height = '0';
    f.tabIndex = -1;
    f.setAttribute('aria-hidden', 'true');
    document.body.appendChild(f);
  }
  signalGooglefcPresent();

  // Manual display units (partials/ad.html). Inline scripts are blocked by the CSP,
  // so each unit is requested here instead of with the usual inline push.
  function fillUnits() {
    var units = document.querySelectorAll('ins.adsbygoogle[data-ad-slot]:not([data-adsbygoogle-status])');
    for (var i = 0; i < units.length; i++) {
      try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fillUnits);
  else fillUnits();
})();
