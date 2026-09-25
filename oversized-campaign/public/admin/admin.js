// Embedded admin. Every request carries an App Bridge session token, which
// the server verifies (signature, audience, shop, expiry). In local demo mode
// there is no App Bridge and the server accepts local requests only.
(function () {
  const demo = document.querySelector('meta[name="osg-demo"]').content === '1';
  const main = document.getElementById('main');
  let current = 'overview';

  async function token() {
    if (demo || !window.shopify || !window.shopify.idToken) return null;
    return window.shopify.idToken();
  }

  async function api(method, path, body) {
    const headers = {};
    const t = await token();
    if (t) headers.authorization = `Bearer ${t}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`/admin/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
    return data;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const dt = (iso) => (iso ? new Date(iso).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'short' }) : '–');
  const n = (v) => Number(v || 0).toLocaleString('da-DK');
  const pill = (text, kind = '') => `<span class="pill ${kind}">${esc(text)}</span>`;
  const toLocalInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  async function status() {
    try {
      const s = await api('GET', '/status');
      document.getElementById('demo').hidden = !s.demoMode;
      document.getElementById('status').innerHTML = [
        s.demoMode ? pill('Demo', 'warn') : pill(s.shop, 'ok'),
        s.demoMode ? '' : s.adminTokenReady ? pill('Admin API klar', 'ok') : pill('Admin API mangler token', 'bad'),
        pill(`API ${s.apiVersion}`),
        s.unresolvedErrors ? pill(`${s.unresolvedErrors} fejl`, 'bad') : '',
      ].join(' ');
    } catch (err) {
      main.innerHTML = `<div class="card"><h2>Ingen adgang</h2><p>${esc(err.message)}</p><p class="note">Administrationen skal åbnes inde fra Shopify admin, så din adgang kan verificeres.</p></div>`;
      throw err;
    }
  }

  const views = {
    async overview() {
      const o = await api('GET', '/overview');
      const k = (v, label) => `<div class="kpi"><div class="v">${n(v)}</div><div class="k">${label}</div></div>`;
      return `<div class="kpis">
        ${k(o.players, 'Spillere')}${k(o.verifiedPlayers, 'Verificerede spillere')}${k(o.rounds, 'Godkendte runder')}
        ${k(o.rejectedRounds, 'Afviste runder')}${k(o.flaggedRounds, 'Markerede runder')}${k(o.bestScore, 'Bedste score')}
        ${k(o.rewardsIssued, 'Rigtige koder udstedt')}${k(o.redeemed, 'Koder indløst')}${k(o.refundedOrders, 'Indløste ordrer m. refusion')}
        ${k(o.rewardsFailed, 'Fejlede udstedelser')}${k(o.demoRewards, 'Demokoder')}
      </div>
      <p class="note">Serveren genberegner hver runde ud fra spillerens input. Det gør manipulation meget sværere, men en bot, der styrer et browserspil, kan ikke udelukkes helt. Markerede runder har usædvanligt maskinagtig timing.</p>`;
    },

    async campaign() {
      const c = await api('GET', '/campaign');
      const tiers = c.tiers.map((t, i) => `<tr><td><input type="number" min="1" name="tier-score-${i}" value="${t.minScore}"></td><td><input type="number" min="1" max="90" name="tier-pct-${i}" value="${t.percent}"> %</td><td><button type="button" class="btn secondary" data-del-tier="${i}">Fjern</button></td></tr>`).join('');
      return `<form class="card" id="campaign-form">
        <h2>Kampagne ${c.isDemoTiers ? pill('Demoniveauer', 'warn') : ''}</h2>
        <div class="grid">
          <label><span>Navn</span><input type="text" name="name" value="${esc(c.name)}" required></label>
          <label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Kampagnen er aktiv</label>
          <label><span>Start (tom = straks)</span><input type="datetime-local" name="startsAt" value="${toLocalInput(c.startsAt)}"></label>
          <label><span>Slut (tom = ingen slutdato)</span><input type="datetime-local" name="endsAt" value="${toLocalInput(c.endsAt)}"></label>
        </div>
        <h2 style="margin-top:18px">Scoregrænser og rabat</h2>
        <table class="tiers-edit"><thead><tr><th>Min. point</th><th>Rabat</th><th></th></tr></thead><tbody>${tiers}</tbody></table>
        <button type="button" class="btn secondary" id="add-tier" style="margin-top:6px">Tilføj niveau</button>
        <h2 style="margin-top:18px">Rabatregler</h2>
        <div class="grid">
          <label><span>Kodepræfiks (A–Z, 0–9)</span><input type="text" name="codePrefix" value="${esc(c.codePrefix)}" pattern="[A-Z0-9]{2,10}"></label>
          <label><span>Koden gælder (dage)</span><input type="number" name="codeValidDays" min="1" max="365" value="${c.codeValidDays}"></label>
          <label><span>Minimumskøb (butikkens valuta, tom = intet)</span><input type="text" name="minimumSubtotal" value="${esc(c.minimumSubtotal || '')}" placeholder="fx 300.00"></label>
          <label><span>Kun produkter (gid://shopify/Product/…, én pr. linje)</span><textarea name="productIds">${esc(c.productIds.join('\n'))}</textarea></label>
          <label><span>Kun kollektioner (gid://shopify/Collection/…, én pr. linje)</span><textarea name="collectionIds">${esc(c.collectionIds.join('\n'))}</textarea></label>
          <div>
            <label class="check"><input type="checkbox" name="combineOrder" ${c.combinesWith.orderDiscounts ? 'checked' : ''}> Kan kombineres med ordrerabatter</label>
            <label class="check"><input type="checkbox" name="combineProduct" ${c.combinesWith.productDiscounts ? 'checked' : ''}> Kan kombineres med produktrabatter</label>
            <label class="check"><input type="checkbox" name="combineShipping" ${c.combinesWith.shippingDiscounts ? 'checked' : ''}> Kan kombineres med fragtrabatter</label>
          </div>
          <div>
            <label class="check"><input type="checkbox" name="requireVerified" ${c.requireVerified ? 'checked' : ''}> Kræv bekræftet e-mail eller kundelogin før en rigtig kode udstedes</label>
            <label class="check"><input type="checkbox" name="restrictToCustomer" ${c.restrictToCustomer ? 'checked' : ''}> Bind koden til kundekontoen, når spilleren er logget ind</label>
            <label class="check"><input type="checkbox" name="leaderboardEnabled" ${c.leaderboardEnabled ? 'checked' : ''}> Offentligt leaderboard</label>
          </div>
        </div>
        <p class="note">Alle koder oprettes med en samlet brugsgrænse på 1 indløsning. Uden krav om bekræftet identitet kan én person få flere koder ved at rydde cookies eller skifte browser.</p>
        <div style="margin-top:14px"><button class="btn" type="submit">Gem kampagne</button><span class="msg" id="campaign-msg"></span></div>
      </form>`;
    },

    async rewards() {
      const { rewards } = await api('GET', '/rewards');
      if (!rewards.length) return '<div class="card"><h2>Belønninger</h2><p class="muted">Ingen udstedte koder endnu.</p></div>';
      const rows = rewards
        .map((r) => {
          const status = r.demo ? pill('Demokode', 'warn') : r.status === 'issued' ? pill('Udstedt', 'ok') : r.status === 'failed' ? pill('Fejlet', 'bad') : pill('Afventer', 'warn');
          const red = r.redemptions
            .map(
              (d) =>
                `${pill('Indløst', 'ok')} ${esc(d.orderName || d.orderId)} · ${esc(d.discountAmount || '')} ${esc(d.currency || '')} · ${dt(d.redeemedAt)}${
                  d.refunds.length ? `<br>${d.refunds.map((f) => `${pill('Refunderet', 'bad')} ${esc(f.amount || '')} ${esc(f.currency || '')} · ${dt(f.at)}`).join('<br>')}` : ''
                }`,
            )
            .join('<br>');
          return `<tr>
            <td><code>${esc(r.code)}</code></td><td>${status}${r.lastError ? `<div class="note">${esc(r.lastError)}</div>` : ''}</td>
            <td class="num">${r.percent} %</td><td class="num">${n(r.score)}</td><td>${esc(r.alias || '–')}<div class="note">${esc(r.identity || 'anonym')}</div></td>
            <td>${dt(r.issuedAt || r.createdAt)}<div class="note">udløber ${dt(r.endsAt)}</div></td>
            <td>${red || '<span class="muted">Ikke brugt</span>'}</td>
            <td>${r.status === 'failed' ? `<button class="btn secondary" data-retry="${r.id}">Prøv igen</button>` : ''}</td>
          </tr>`;
        })
        .join('');
      return `<div class="card"><h2>Belønninger</h2><div class="scroll"><table>
        <thead><tr><th>Kode</th><th>Status</th><th>Rabat</th><th>Score</th><th>Spiller</th><th>Udstedt</th><th>Indløsning</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>
        <p class="note">Indløsninger registreres fra betalte ordrer (webhook orders/paid) via rabatkoden. Refunderinger registreres særskilt og gør ikke en brugt kode gyldig igen.</p></div>`;
    },

    async rounds() {
      const { rounds } = await api('GET', '/rounds');
      const rows = rounds
        .map(
          (r) => `<tr><td>${dt(r.started_at)}</td><td>${esc(r.alias || r.player_id.slice(0, 8))}</td>
          <td>${r.status === 'verified' ? pill('Godkendt', 'ok') : r.status === 'rejected' ? pill('Afvist', 'bad') : pill(r.status)}</td>
          <td class="num">${r.score ?? '–'}</td><td class="num">${r.approved_reps ?? '–'}</td><td class="num">${r.clean_reps ?? '–'}</td><td class="num">${r.top_kg ?? '–'}</td>
          <td>${esc(r.reject_reason || '')}${r.flags ? ` ${pill(r.flags, 'warn')}` : ''}</td><td>v${r.rules_version}${r.campaign_id ? '' : ' · uden kampagne'}</td></tr>`,
        )
        .join('');
      return `<div class="card"><h2>Seneste 200 runder</h2><div class="scroll"><table>
        <thead><tr><th>Start</th><th>Spiller</th><th>Status</th><th>Score</th><th>Godk.</th><th>Rene</th><th>Top kg</th><th>Note</th><th>Regler</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="9" class="muted">Ingen runder endnu.</td></tr>'}</tbody></table></div></div>`;
    },

    async players() {
      const { players } = await api('GET', '/players');
      const rows = players
        .map(
          (p) => `<tr><td>${esc(p.alias || '–')} ${p.leaderboardOptIn ? pill('leaderboard') : ''} ${p.aliasHidden ? pill('skjult', 'warn') : ''}</td>
          <td>${esc(p.email || '–')}</td><td>${p.shopifyCustomerId ? `<code>${esc(p.shopifyCustomerId)}</code>` : '–'}</td>
          <td>${p.marketingOptIn ? pill('ja', 'ok') : 'nej'}</td>
          <td class="num">${n(p.bestScore)}</td><td class="num">${p.roundsPlayed}</td><td>${dt(p.lastSeenAt)}</td>
          <td>${p.alias ? `<button class="btn secondary" data-hide="${p.id}" data-hidden="${p.aliasHidden ? '0' : '1'}">${p.aliasHidden ? 'Vis alias' : 'Skjul alias'}</button>` : ''}</td></tr>`,
        )
        .join('');
      return `<div class="card"><h2>Spillere</h2><div class="scroll"><table>
        <thead><tr><th>Alias</th><th>E-mail (maskeret)</th><th>Kunde-ID</th><th>Nyhedsbrev</th><th>Rekord</th><th>Runder</th><th>Sidst set</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" class="muted">Ingen spillere endnu.</td></tr>'}</tbody></table></div></div>`;
    },

    async errors() {
      const { errors } = await api('GET', '/errors');
      const rows = errors
        .map(
          (e) => `<tr><td>${dt(e.createdAt)}</td><td><code>${esc(e.source)}</code></td><td>${esc(e.message)}${e.details ? `<div class="note"><code>${esc(JSON.stringify(e.details).slice(0, 300))}</code></div>` : ''}</td>
          <td>${e.resolvedAt ? pill('Løst', 'ok') : `<button class="btn secondary" data-resolve="${e.id}">Markér løst</button>`}</td></tr>`,
        )
        .join('');
      return `<div class="card"><h2>Integrationsfejl</h2><div class="scroll"><table>
        <thead><tr><th>Tid</th><th>Kilde</th><th>Besked</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="muted">Ingen fejl.</td></tr>'}</tbody></table></div></div>`;
    },
  };

  function readCampaign(form, extraTiers) {
    const f = new FormData(form);
    const lines = (v) => String(v || '').split(/\s+/).map((s) => s.trim()).filter(Boolean);
    const tiers = [];
    form.querySelectorAll('[name^="tier-score-"]').forEach((input) => {
      const i = input.name.split('-').pop();
      tiers.push({ minScore: Number(input.value), percent: Number(form.querySelector(`[name="tier-pct-${i}"]`).value) });
    });
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    return {
      name: f.get('name'),
      active: f.get('active') === 'on',
      startsAt: iso(f.get('startsAt')),
      endsAt: iso(f.get('endsAt')),
      tiers: tiers.concat(extraTiers || []),
      codePrefix: String(f.get('codePrefix')).toUpperCase(),
      codeValidDays: Number(f.get('codeValidDays')),
      minimumSubtotal: f.get('minimumSubtotal') ? String(f.get('minimumSubtotal')).replace(',', '.') : null,
      productIds: lines(f.get('productIds')),
      collectionIds: lines(f.get('collectionIds')),
      combinesWith: { orderDiscounts: f.get('combineOrder') === 'on', productDiscounts: f.get('combineProduct') === 'on', shippingDiscounts: f.get('combineShipping') === 'on' },
      requireVerified: f.get('requireVerified') === 'on',
      restrictToCustomer: f.get('restrictToCustomer') === 'on',
      leaderboardEnabled: f.get('leaderboardEnabled') === 'on',
    };
  }

  async function show(tab) {
    current = tab;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    main.innerHTML = '<p class="muted">Indlæser…</p>';
    try {
      main.innerHTML = await views[tab]();
    } catch (err) {
      main.innerHTML = `<div class="card"><h2>Fejl</h2><p>${esc(err.message)}</p></div>`;
      return;
    }
    const form = document.getElementById('campaign-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = document.getElementById('campaign-msg');
        try {
          await api('PUT', '/campaign', readCampaign(form));
          msg.textContent = 'Gemt ✓';
          status();
        } catch (err) {
          msg.textContent = err.message;
        }
      });
      document.getElementById('add-tier').addEventListener('click', async () => {
        const body = form.querySelector('.tiers-edit tbody');
        const i = body.children.length + Date.now() % 1000;
        body.insertAdjacentHTML('beforeend', `<tr><td><input type="number" min="1" name="tier-score-${i}" value="3000"></td><td><input type="number" min="1" max="90" name="tier-pct-${i}" value="20"> %</td><td></td></tr>`);
      });
      form.querySelectorAll('[data-del-tier]').forEach((b) => b.addEventListener('click', () => b.closest('tr').remove()));
    }
    main.querySelectorAll('[data-retry]').forEach((b) =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        await api('POST', `/rewards/${b.dataset.retry}/retry`).catch((err) => alert(err.message));
        show('rewards');
      }),
    );
    main.querySelectorAll('[data-hide]').forEach((b) =>
      b.addEventListener('click', async () => {
        await api('POST', `/players/${b.dataset.hide}/alias-hidden`, { hidden: b.dataset.hidden === '1' });
        show('players');
      }),
    );
    main.querySelectorAll('[data-resolve]').forEach((b) =>
      b.addEventListener('click', async () => {
        await api('POST', `/errors/${b.dataset.resolve}/resolve`, {});
        show('errors');
        status();
      }),
    );
  }

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  status().then(() => show(current), () => {});
})();
