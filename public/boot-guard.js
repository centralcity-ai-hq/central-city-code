// Deploy-swap guard (1 Nov 2026). For a moment while production moves to a new build, a page can
// come from one build and its hashed entry script or CSS from the other: the file 404s, nothing of
// the app runs, and the page stays blank (src/shell/chunkReload.ts only covers lazy chunks, once
// the app runs). This file has a fixed name in every build, so it is always there. It reloads the
// page when an /assets/ script or stylesheet fails, after refetching that file past the cache
// (hashed assets are cached immutable, including a 404), at most 3 times within a minute.
(function () {
  var KEY = 'cc.bootGuard';
  var DELAYS = [0, 1000, 3000];
  function state() {
    try {
      var s = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (s && Date.now() - s.t < 60000) return s;
    } catch (e) {}
    return { t: Date.now(), n: 0 };
  }
  var pending = false;
  window.addEventListener(
    'error',
    function (ev) {
      var el = ev && ev.target;
      if (pending || !el || (el.tagName !== 'SCRIPT' && el.tagName !== 'LINK')) return;
      var url = el.src || el.href || '';
      if (url.indexOf('/assets/') === -1) return;
      var s = state();
      if (s.n >= DELAYS.length) return;
      pending = true;
      var wait = DELAYS[s.n];
      s.n += 1;
      try {
        sessionStorage.setItem(KEY, JSON.stringify(s));
      } catch (e) {}
      var go = function () {
        window.location.reload();
      };
      try {
        fetch(url, { cache: 'reload' }).then(
          function () {
            setTimeout(go, wait);
          },
          function () {
            setTimeout(go, wait);
          },
        );
      } catch (e) {
        setTimeout(go, wait);
      }
    },
    true,
  );
})();
