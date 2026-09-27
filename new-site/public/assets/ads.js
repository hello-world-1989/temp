// Google AdSense (auto ads + manual units) and Google's consent message, same account as the old site.
// Loaded on every page; skipped when developing locally.
(function () {
  var host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return;
  // Old-site pages served here load AdSense themselves on end-gfw.com
  if (document.querySelector('script[src*="adsbygoogle.js"]')) return;

  var CLIENT = 'ca-pub-7165471280882308';

  function add(src, onload, onerror) {
    var s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    if (onload) s.onload = onload;
    if (onerror) s.onerror = onerror;
    document.head.appendChild(s);
  }

  // Tells AdSense that Google's consent message is on the page, so it waits for consent.
  // Only sent once the consent script has actually loaded: when that script fails
  // (it returns 503 for domains without a published message), the signal would make
  // AdSense wait forever and no ad would ever be requested.
  function signalGooglefcPresent(done) {
    if (window.frames['googlefcPresent']) return done();
    if (!document.body) return setTimeout(function () { signalGooglefcPresent(done); }, 0);
    var f = document.createElement('iframe');
    f.name = 'googlefcPresent';
    f.hidden = true;
    f.width = '0';
    f.height = '0';
    f.tabIndex = -1;
    f.setAttribute('aria-hidden', 'true');
    document.body.appendChild(f);
    done();
  }

  // Manual display units (partials/ad.html). Inline scripts are blocked by the CSP,
  // so each unit is requested here instead of with the usual inline push.
  function fillUnits() {
    var units = document.querySelectorAll('ins.adsbygoogle[data-ad-slot]:not([data-adsbygoogle-status])');
    for (var i = 0; i < units.length; i++) {
      try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}
    }
  }

  var started = false;
  function startAds() {
    if (started) return;
    started = true;
    add('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + CLIENT);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fillUnits);
    else fillUnits();
  }

  add(
    'https://fundingchoicesmessages.google.com/i/' + CLIENT.replace('ca-', '') + '?ers=1',
    function () { signalGooglefcPresent(startAds); },
    startAds
  );
  // Don't hold ads back if the consent script hangs
  setTimeout(startAds, 4000);
})();
