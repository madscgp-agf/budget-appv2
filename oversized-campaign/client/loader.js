// Storefront loader for the Oversized Bench app block. Tiny on purpose: the
// 3D game (three.js and all) is only downloaded when a visitor opens it.
(function () {
  if (window.__oversizedBenchLoader) return;
  window.__oversizedBenchLoader = true;

  function open(block) {
    if (document.querySelector('[data-oversized-overlay]')) return;
    var btn = block.querySelector('[data-oversized-open]');
    var label = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = btn.getAttribute('data-loading-label') || 'Indlæser…';
    }
    var overlay = document.createElement('div');
    overlay.setAttribute('data-oversized-overlay', '');
    document.body.appendChild(overlay);
    var prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    var restore = function () {
      document.documentElement.style.overflow = prevOverflow;
      overlay.remove();
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
        btn.focus();
      }
    };
    import(block.getAttribute('data-bundle'))
      .then(function (m) {
        m.mount(overlay, {
          apiBase: (block.getAttribute('data-api') || '').replace(/\/$/, ''),
          proxyBase: block.getAttribute('data-proxy') || null,
          customerLoggedIn: block.getAttribute('data-customer') === '1',
          athleteModelUrl: block.getAttribute('data-athlete-model') || null,
          onClose: restore,
        });
        if (btn) btn.textContent = label;
      })
      .catch(function (err) {
        console.error('[Oversized Bench]', err);
        restore();
        var msg = block.querySelector('[data-oversized-error]');
        if (msg) msg.hidden = false;
      });
  }

  function prefetch(block) {
    if (block.__prefetched) return;
    block.__prefetched = true;
    var l = document.createElement('link');
    l.rel = 'modulepreload';
    l.href = block.getAttribute('data-bundle');
    document.head.appendChild(l);
  }

  function init(root) {
    (root || document).querySelectorAll('[data-oversized-bench]').forEach(function (block) {
      if (block.__oversizedReady) return;
      block.__oversizedReady = true;
      var btn = block.querySelector('[data-oversized-open]');
      if (!btn) return;
      btn.addEventListener('click', function () { open(block); });
      // Warm the cache only on clear intent (desktop hover / keyboard focus).
      btn.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') prefetch(block); });
      btn.addEventListener('focus', function () { prefetch(block); });
      if (location.hash === '#oversized-bench') open(block);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { init(); });
  else init();
  // Theme editor: re-init when a section with the block is added or re-rendered.
  document.addEventListener('shopify:section:load', function (e) { init(e.target); });
})();
