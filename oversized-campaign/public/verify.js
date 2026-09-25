// The token sits in the URL fragment, which browsers never send to servers.
// We only use it when the person clicks, so link scanners in mail clients
// cannot use up the link by fetching the page.
(function () {
  var token = new URLSearchParams(location.hash.slice(1)).get('t');
  history.replaceState(null, '', location.pathname);
  var go = document.getElementById('go');
  var msg = document.getElementById('msg');
  var back = document.getElementById('back');
  if (!token) {
    go.hidden = true;
    msg.textContent = 'Linket mangler sin kode. Åbn linket direkte fra mailen.';
    back.hidden = false;
    return;
  }
  go.addEventListener('click', function () {
    go.disabled = true;
    msg.textContent = 'Bekræfter…';
    fetch('/api/email-verify', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token }),
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.body.error || 'Det gik ikke');
        var p = r.body.player;
        go.hidden = true;
        document.getElementById('text').textContent = '';
        msg.textContent = 'Bekræftet! ' + (p && p.bestScore ? 'Din rekord er ' + p.bestScore.toLocaleString('da-DK') + ' point.' : '') + ' Denne browser genkender dig nu.';
        back.hidden = false;
      })
      .catch(function (e) {
        go.disabled = false;
        msg.textContent = e.message;
      });
  });
})();
