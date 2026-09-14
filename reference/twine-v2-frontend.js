
(() => {
  const $ = id => document.getElementById(id);
  let lastSupply = null, lastFx = null, lastReserve = null;   // lastReserve: the last /api/pool (the launch reserve panel, home page only)
  const fmtUsd = n => n == null || !isFinite(n) ? '—' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'k' : '$' + n.toFixed(0);
  const fmtUsdFull = n => n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US');
  const fmtPrice = p => p == null ? '—' : '$' + (p < 1e-4 ? p.toExponential(3) : p.toFixed(p < 0.01 ? 6 : 4));
  const short = a => a && a.length > 16 ? a.slice(0, 6) + '…' + a.slice(-4) : (a ?? '');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const timeLeft = iso => { const ms = Date.parse(iso) - Date.now(); if (ms <= 0) return 'ended'; const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000); return h >= 48 ? Math.floor(h / 24) + 'd ' + (h % 24) + 'h left' : h >= 1 ? h + 'h ' + m + 'm left' : m + 'm left'; };
  const ago = iso => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; };
  const stateText = a => ({ open: 'Open', filled: 'Filled · launching', launching: 'Launching', live: 'Live', expired: 'Expired · refunding', refunded: 'Refunded', refund_partial: 'Refunded · partial', launch_failed: 'Launch failed', cancelled: 'Cancelled' }[a.status] ?? a.status);
  const ident = (a, big) => `<div class="${big ? 'ahead' : 'ident'}">${a.image ? `<img class="img" src="${esc(a.image)}" alt="">` : `<span class="mono">${esc((a.symbol || '?')[0])}</span>`}<div class="txt">${big ? `<h2>${esc(a.name)}</h2><span class="sym">$${esc(a.symbol)}</span>` : `<b>${esc(a.name)}</b><i>$${esc(a.symbol)}</i>`}</div></div>`;
  const setText = (id, t) => { const el = $(id); if (el && el.textContent !== t) el.textContent = t; };
  let range = '6h', state = null, view = { name: 'home', id: null }, publicCreate = false;
  let paidInfo = null, paidEnabled = false, launchMode = null, paidImage = null, paidPage = null;   // Launch now: the last /api/paid/quote, the launch view's mode, the paid form's image, the record shown on /a/<id>
  let mirrorId = null;   // the coin whose mirror block (#view-coin) is mounted on its launch page (/a/<id>); null while the block sits in its home position

  // ---- routing ----
  function route() {
    const p = location.pathname; let m;
    if (p === '/launch') view = { name: 'launch' };
    else if (p === '/auctions' || p === '/launches') view = { name: 'auctions' };   // the Launches tab keeps its /auctions address (nginx maps it); /launches is an alias
    else if ((m = p.match(/^\/a\/([a-z0-9-]+)$/))) view = { name: 'auction', id: m[1] };
    else if ((m = p.match(/^\/c\/([a-z0-9-]+)$/))) view = { name: 'coin', id: m[1] };
    else view = { name: 'home' };
    if (!(view.name === 'auction' && paidPage?.id === view.id)) mountMirror(null);   // leaving a launch page (or moving to another one): the mirror block goes back to its home position; tick() mounts it again where it belongs
    $('view-coin').hidden = !(view.name === 'home' || view.name === 'coin' || mirrorId);
    $('view-home').hidden = view.name !== 'home';
    $('how').hidden = !(view.name === 'home' || view.name === 'coin');
    $('view-auctions').hidden = view.name !== 'auctions';
    $('view-auction').hidden = view.name !== 'auction' || (paidPage?.id === view.id);   // /a/<id>: an auction, or a paid launch (decided by the record's `mode` once it arrives)
    $('view-paid').hidden = !(view.name === 'auction' && paidPage?.id === view.id);
    $('view-launch').hidden = view.name !== 'launch';
    $('coin-back').hidden = view.name !== 'coin';
    for (const id of ['how', 'flywheel']) { const el = $(id); if (el) el.hidden = !(view.name === 'home' || view.name === 'coin'); }   // flywheel visibility
    $('coin').hidden = !(view.name === 'home' || view.name === 'coin');
    // the tab title per view: render() only sets it on home/coin, the auction and status pages set their own once their record arrives
    document.title = view.name === 'launch' ? 'Launch a token · Twine' : view.name === 'auctions' ? (hideV1 ? 'Launches' : 'Auctions') + ' · Twine' : view.name === 'auction' ? 'Twine' : 'Twine — one coin, two chains';
    renderSupply(lastSupply); renderReserve(lastReserve);
    document.querySelectorAll('[data-tab]').forEach(t => { const on = t.dataset.tab === (view.name === 'coin' ? 'home' : view.name === 'auction' ? 'auctions' : view.name); t.classList.toggle('active', on); if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
    window.scrollTo(0, 0); tick();
  }
  document.addEventListener('click', e => { const a = e.target.closest('a[data-nav]'); if (!a || e.metaKey || e.ctrlKey || e.button) return; const href = a.getAttribute('href'); if (!href || href === '#') return; e.preventDefault(); history.pushState(null, '', href); route(); });
  window.addEventListener('popstate', route);
  // the coin's mirror on its launch page: a live v2 coin's status page (/a/<id>) carries the coin block itself. #view-coin (the flagship's block on the home
  // page, any coin's on /c/<id>) is moved into #p-mirror above the timeline and back before #view-home when the page is left — one block, one set of ids,
  // one renderer (render/draw), the coin view's 3 s tick and range. Only the fee panel stays hidden there (the page has its own) and the hero sentence
  // gives way to the record's header (CSS under #p-mirror).
  const mirrorCoinOf = a => a?.mode === 'paid' && ['live', 'retiring', 'retired'].includes(a.status) && a.coinId ? a.coinId : null;
  function mountMirror(id) {
    if (id === mirrorId) return; const vc = $('view-coin'), slot = $('p-mirror');
    if (id) { slot.appendChild(vc); slot.hidden = false; vc.hidden = false; } else { $('view-home').before(vc); slot.hidden = true; vc.hidden = !(view.name === 'home' || view.name === 'coin'); }
    mirrorId = id; chartGeom = null; tipEl.hidden = true;
  }

  // ---- coin view ----
  function renderPill(s) {   // the header's status pill: the flagship's state — from render() on the home page, on its own from the other views (their coin block shows another coin or nothing)
    const live = s.status === 'live', pill = $('status'); pill.className = 'pill ' + (live ? (s.inBand ? 'live' : 'off') : 'wait'); setText('status-text', live ? (s.inBand ? 'Live · mirrored' : 'Live · closing the gap') : (s.status === 'starting' ? 'Reading the chains' : 'Launching soon'));
    if (s.fx) lastFx = s.fx;
  }
  function render(s) {
    state = s;
    const live = s.status === 'live';
    document.body.classList.toggle('prelaunch', !live);
    if (view.name === 'home' || s.coin?.id === 'twine' || !s.coin) renderPill(s);
    if (s.meta) { setText('coin-name', s.meta.name ?? 'Twine'); setText('coin-symbol', s.meta.symbol ? '$' + s.meta.symbol : ''); const img = $('coin-img'); if (s.meta.image) { img.src = s.meta.image; img.hidden = false; } else img.hidden = true;
      const soc = [['X', s.meta.twitter], ['Telegram', s.meta.telegram], ['Website', s.meta.website]].filter(x => x[1]).map(([l, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${l}</a>`).join(' · '); $('socials').innerHTML = soc; }
    if (view.name === 'home' || view.name === 'coin') document.title = (s.meta?.symbol ? '$' + s.meta.symbol + ' · ' : '') + 'Twine — one coin, two chains';   // render() also feeds the header pill on the other views: their titles are theirs
    // the coin page's version label: v2 mirror (Launch now, fee-powered) or v1 launch (auction); the flagship and the home page carry none
    { const chip = $('coin-mode'), mode = s.coin?.mode; chip.hidden = !(view.name === 'coin' && (mode === 'paid' || mode === 'auction')); if (!chip.hidden) { chip.className = 'feelabel' + (mode === 'paid' ? '' : ' v1'); chip.textContent = mode === 'paid' ? 'v2 mirror' : 'v1 launch'; } }
    { const lk = $('coin-launch-link'), mode = s.coin?.mode; lk.hidden = !(view.name === 'coin' && (mode === 'paid' || mode === 'auction')); if (!lk.hidden) lk.setAttribute('href', '/a/' + s.coin.id); }   // the coin page → its launch page (deposit, approval, launch steps, the waterfall); that page links back with "View the mirror" and carries the mirror itself
    if (s.gap != null) { const g = $('gap'); g.textContent = (s.gap * 100).toFixed(2) + '%'; g.className = 'v ' + (s.inBand ? 'ok' : 'bad'); setText('gap-side', s.expensive === 'pump' ? 'pump.fun higher' : 'PONS higher'); }
    else { setText('gap', '—'); setText('gap-side', ''); }
    for (const [id, v] of [['pump', s.pump], ['pons', s.pons]]) {
      setText(id + '-mc', v ? fmtUsd(v.fdv) : '—'); setText(id + '-price', v ? fmtPrice(v.price) : '—');
      setText(id + '-depth', v ? v.quoteDepth.toFixed(v.quoteDepth < 10 ? 3 : 1) + ' ' + v.quoteSymbol : '—');
      setText(id + '-phase', v ? v.phaseLabel : 'bonding curve');
      $(id + '-bar').style.width = v ? Math.round(v.progress * 100) + '%' : '0%';
      const pooled = v && (v.kind === 'pumpswap' || v.kind === 'v4'); $(id + '-grad').hidden = Boolean(pooled); setText(id + '-depth-label', pooled ? 'quote in pool' : 'quote in curve');
    }
    if (s.pair) {
      const mint = s.pair.pumpMint, tok = s.pair.ponsToken ?? s.pair.ponsCurve;
      setText('pump-ca', mint); $('pump-buy').href = 'https://pump.fun/coin/' + mint; $('pump-axiom').href = 'https://axiom.trade/t/' + mint; $('pump-gmgn').href = 'https://gmgn.ai/sol/token/' + mint;
      setText('pons-ca', tok); $('pons-buy').href = 'https://www.ponsfamily.com/launchpad/' + tok; $('pons-explorer').href = 'https://robinhoodchain.blockscout.com/token/' + tok;
    } else { setText('pump-ca', 'revealed at launch'); setText('pons-ca', 'revealed at launch'); }
    if (s.gap != null) { const signed = (s.expensive === 'pump' ? -1 : 1) * Math.min(s.gap, 0.25); const pct = 50 + signed / 0.25 * 45; const n = $('needle'); if (window.matchMedia('(max-width:900px)').matches) { n.style.left = 'calc(' + pct + '% - 3px)'; n.style.top = ''; } else { n.style.top = 'calc(' + pct + '% - 3px)'; n.style.left = ''; } n.style.background = s.inBand ? 'var(--ok)' : 'var(--bad)'; }
    setText('spine-top', s.pump ? fmtUsd(s.pump.fdv) : '—'); setText('spine-bottom', s.pons ? fmtUsd(s.pons.fdv) : '—');
    setText('band-note', live ? (s.inBand ? 'Inside the 5% mirror band.' : 'Outside the band: the maker is closing it.') : 'The lit band is the 5% mirror target.');
    const st = s.stats || {}; setText('st-inband', st.inBandPct == null ? '—' : st.inBandPct.toFixed(1) + '%'); setText('st-maxgap', st.maxGap == null ? '—' : (st.maxGap * 100).toFixed(1) + '%'); setText('st-high', fmtUsd(st.high)); setText('st-low', fmtUsd(st.low));
    setText('updated', s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : '—');
    draw(s.series || [], s.band || 0.05);
    lastSupply = s.supply; if (s.fx) lastFx = s.fx; renderSupply(s.supply);
    const fs = $('fee-section'); fs.hidden = !s.paid || Boolean(mirrorId); if (s.paid) { renderFeeNumbers(s.paid, 'fee-grid', 'fee-prog', s.fx || lastFx); $('fee-status-link').setAttribute('href', '/a/' + (s.coin?.id ?? '')); }   // fee-mode coins: the waterfall's numbers (not on the launch page, which has its own panel under the mirror)
  }
  const fmtTok = n => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e8 ? 1 : 2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
  function renderSupply(sd) {
    const sec = $('supply-section'); if (!sec) return; sec.hidden = !(sd && sd.pump?.supply) || !(view.name === 'home' || view.name === 'coin'); if (sec.hidden) return;
    const side = (key, label, accent) => { const v = sd[key]; if (!v?.supply) return `<div class="side"><h3><span class="sw" style="background:${accent}"></span>${label}</h3><p class="note">not read yet</p></div>`;
      const pct = n => (n / v.minted * 100).toFixed(2) + '%', maker = v.maker ?? 0, circ = Math.max(0, v.circulating - maker), ours = (sd.events || []).filter(e => e.type === 'burn' && e.chain === (key === 'pump' ? 'sol' : 'rh')).reduce((s, e) => s + e.tokens, 0), others = v.burned - ours;
      return `<div class="side" style="--accent:${accent}"><h3><span class="sw" style="background:${accent}"></span>${label}</h3>
        <div class="sbar" title="of the 1B minted"><i class="circ" style="width:${circ / v.minted * 100}%"></i><i class="mk" style="width:${maker / v.minted * 100}%"></i><i class="lock" style="width:${v.locked / v.minted * 100}%"></i><i class="burn" style="width:${v.burned / v.minted * 100}%"></i></div>
        <div class="srow"><span class="k" style="--dot:var(--muted)">circulating (others)</span><span>${fmtTok(circ)}</span><span>${pct(circ)}</span><span class="k" style="--dot:${accent}">market maker</span><span>${fmtTok(maker)}</span><span>${pct(maker)}</span><span class="k" style="--dot:#ffb020">locked</span><span>${fmtTok(v.locked)}</span><span>${pct(v.locked)}</span><span class="k" style="--dot:var(--bad)">burned</span><span>${fmtTok(v.burned)}</span><span>${pct(v.burned)}</span><span class="k" style="--dot:var(--text)">total supply now</span><span>${fmtTok(v.supply)}</span><span>${pct(v.supply)}</span></div>${others > 1000 ? `<p class="note" style="margin:0">${fmtTok(ours)} burned by Twine; ${fmtTok(others)} burned by other holders.</p>` : ''}</div>`; };
    $('supply-grid').innerHTML = side('pump', 'pump.fun · Solana', 'var(--sol)') + side('pons', 'PONS · Robinhood Chain', 'var(--rh)');
    const E = (sd.events || []).slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); $('supply-events-wrap').hidden = !E.length;
    $('supply-events').innerHTML = E.map(e => `<tr><td>${new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>${e.type === 'lock' ? 'locked' + (e.via ? ' · ' + esc(e.via) : '') + (e.until ? ' until ' + new Date(e.until).toLocaleDateString() : '') : 'burned'}${e.note ? ' · ' + esc(e.note) : ''}</td><td><span class="dot" style="background:var(--${e.chain === 'sol' ? 'sol' : 'rh'})"></span>${e.chain === 'sol' ? 'pump.fun' : 'PONS'}</td><td class="r num">${Math.round(e.tokens).toLocaleString('en-US')}</td><td>${e.tx ? `<a href="${e.chain === 'sol' ? 'https://solscan.io/tx/' : 'https://robinhoodchain.blockscout.com/tx/'}${esc(e.tx)}" target="_blank" rel="noopener">${esc(e.tx.slice(0, 10))}…</a>` : ''}</td></tr>`).join('');
  }
  // the launch reserve (public /api/pool): one side per asset like the supply panel — floor (never lent), available above it, out in
  // fronts — then the gates with their slots, the fronts, and the totals repaid / refunded / recovered; the wallets as explorer links
  const fmtAmt = (n, unit, d) => n == null || !isFinite(n) ? '—' : Number(n).toFixed(d) + ' ' + unit;
  const walletLink = (addr, chain) => !addr ? '—' : chain === 'sol' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr) ? `<a href="https://solscan.io/account/${esc(addr)}" target="_blank" rel="noopener">${short(addr)}</a>` : chain === 'rh' && /^0x[0-9a-fA-F]{40}$/.test(addr) ? `<a href="https://robinhoodchain.blockscout.com/address/${esc(addr)}" target="_blank" rel="noopener">${short(addr)}</a>` : `<code>${esc(addr)}</code>`;
  function renderReserve(r) {
    lastReserve = r; const sec = $('reserve-section'); if (!sec) return; sec.hidden = !(r && r.enabled) || view.name !== 'home'; if (sec.hidden) return;
    const g = r.gates || {}, fx = r.fx || lastFx, gate = $('reserve-gate');
    { const F = r.funding, host = gate.parentNode; let t = document.getElementById('reserve-target'); if (F && host) { if (!t) { t = document.createElement('div'); t.id = 'reserve-target'; t.className = 'note'; host.insertBefore(t, gate.nextSibling); } const pc = (v, tt) => tt > 0 ? Math.round(100 * (Number(v) || 0) / tt) : '—'; t.textContent = F.poolFull ? `reserve at target (${F.poolTargetSol} SOL / ${F.poolTargetEth} ETH)${F.burnAllowed ? ' · TWINE burns on' : ' · waiting on the TWINE makers to fill'}` : `reserve target ${F.poolTargetSol} SOL / ${F.poolTargetEth} ETH · ${pc(r.sol?.balance, F.poolTargetSol)}% SOL · ${pc(r.eth?.balance, F.poolTargetEth)}% ETH · the fee share of funded coins refills it${F.contributedSol ? ` (${(+F.contributedSol).toFixed(1)} SOL so far)` : ''}`; } else if (t) t.remove(); }
    gate.className = 'gate ' + (g.open ? 'open' : 'closed'); gate.textContent = g.open ? `launches open · ${g.money?.slots ?? '—'} money slot${g.money?.slots === 1 ? '' : 's'} · ${g.machines?.slots ?? '—'} maker slot${g.machines?.slots === 1 ? '' : 's'}` : `launches closed${g.queue ? ` · ${g.queue} in queue` : ''}`;
    const side = (key, label, accent, unit, d) => { const v = r[key]; if (!v) return `<div class="side" style="--accent:${accent}"><h3><span class="sw" style="background:${accent}"></span>${label}</h3><p class="note">${esc(r.error || 'not read yet')}</p></div>`;
      const total = Math.max(1e-9, v.balance + v.outstanding), w = n => Math.max(0, Math.min(100, n / total * 100)), flr = Math.min(v.floor, v.balance), usd = v.usd || {};
      return `<div class="side" style="--accent:${accent}"><h3><span class="sw" style="background:${accent}"></span>${label}</h3>
        <div class="sbar" title="balance plus what is out in fronts"><i class="flr" style="width:${w(flr)}%"></i><i class="avail" style="width:${w(v.available)}%"></i><i class="out" style="width:${w(v.outstanding)}%"></i></div>
        <div class="srow"><span class="k" style="--dot:${accent}">available to front</span><span>${fmtAmt(v.available, unit, d)}</span><span>${usd.available != null ? fmtUsdFull(usd.available) : ''}</span><span class="k" style="--dot:#ffb020">floor · never lent</span><span>${fmtAmt(v.floor, unit, d)}</span><span></span><span class="k" style="--dot:var(--muted)">out in fronts</span><span>${fmtAmt(v.outstanding, unit, d)}</span><span>${usd.outstanding != null ? fmtUsdFull(usd.outstanding) : ''}</span><span class="k" style="--dot:var(--text)">balance now</span><span>${fmtAmt(v.balance, unit, d)}</span><span>${usd.balance != null ? fmtUsdFull(usd.balance) : ''}</span></div></div>`; };
    $('reserve-grid').innerHTML = side('sol', 'SOL · Solana', 'var(--sol)', 'SOL', 2) + side('eth', 'ETH · Robinhood Chain', 'var(--rh)', 'ETH', 4);
    const F = r.fronts || {}, T = r.totals || {}, rec = T.recovered || {}, L = T.launches || {};
    $('reserve-stats').innerHTML = [
      ['launches', g.open ? `open<small>${g.money?.slots ?? '—'} money · ${g.machines?.slots ?? '—'} of ${g.machines?.max ?? '—'} maker slots free</small>` : `closed<small>${g.closed ? 'by the operator' : g.machines && !g.machines.open ? 'every maker slot in use' : g.money?.error ? 'the pool is not reachable' : g.money?.nextFrontSol != null ? `next front ${fmtAmt(g.money.nextFrontSol, 'SOL', 2)} · ${fmtAmt(g.money.availableSol, 'SOL', 1)} free` : 'money gate'}${g.queue ? ` · ${g.queue} in queue` : ''}</small>`, g.open ? 'ok' : ''],
      ['fronted', `${F.count ?? 0} launch${F.count === 1 ? '' : 'es'}<small>${F.open ?? 0} open · ${fmtAmt(F.outstandingSol, 'SOL', 2)} + ${fmtAmt(F.outstandingEth, 'ETH', 4)} outstanding${F.outstandingUsd != null ? ' ≈ ' + fmtUsdFull(F.outstandingUsd) : ''}</small>`, ''],
      ['repaid to the reserve', `${fmtAmt(T.repaidSol, 'SOL', 3)}<small>${T.writtenOffSol ? fmtAmt(T.writtenOffSol, 'SOL', 3) + ' written off · ' : ''}${L.live ?? 0} live · ${L.retired ?? 0} retired</small>`, ''],
      ['deposits refunded · recovered', `${fmtAmt(T.depositsRefundedSol, 'SOL', 3)}<small>refunded to devs · ${rec.coins ? `${fmtAmt(rec.sol, 'SOL', 3)} + ${fmtAmt(rec.eth, 'ETH', 4)} back from ${rec.coins} retired coin${rec.coins === 1 ? '' : 's'}` : 'nothing recovered yet'}</small>`, ''],
    ].map(([l, v, c]) => `<div><span class="label">${l}</span><div class="n ${c}">${v}</div></div>`).join('');
    const A = r.addresses; $('reserve-wallets').innerHTML = A ? `<span>pool wallets</span><span>Solana ${walletLink(A.sol, 'sol')}</span><span>Robinhood Chain ${walletLink(A.rh, 'rh')}</span>${r.demo ? '<span>demo pool: no chain behind it</span>' : ''}${fx ? `<span>SOL ${fmtUsdFull(fx.SOL)} · ETH ${fmtUsdFull(fx.ETH)}</span>` : ''}` : (r.error ? `<span>${esc(r.error)}</span>` : '');
  }
  // ---- chart: the two market caps with a ribbon between them coloured by whichever side runs ahead, then the spread ----
  const tipEl = (() => { const w = $('chart').parentElement; let t = w.querySelector('.tip'); if (!t) { t = document.createElement('div'); t.className = 'tip'; t.hidden = true; w.appendChild(t); } return t; })();
  let chartGeom = null;
  // monotone cubic tangents (Fritsch–Carlson): smooth lines that never overshoot the samples
  function tangents(pts) {
    const n = pts.length, dx = [], sl = [], m = [];
    for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1].x - pts[i].x; sl[i] = dx[i] ? (pts[i + 1].y - pts[i].y) / dx[i] : 0; }
    if (n === 1) return [0];
    m[0] = sl[0]; m[n - 1] = sl[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = sl[i - 1] * sl[i] <= 0 ? 0 : (sl[i - 1] + sl[i]) / 2;
    for (let i = 0; i < n - 1; i++) { if (!sl[i]) { m[i] = 0; m[i + 1] = 0; continue; } const a = m[i] / sl[i], b = m[i + 1] / sl[i], h = Math.hypot(a, b); if (h > 3) { m[i] = 3 * a / h * sl[i]; m[i + 1] = 3 * b / h * sl[i]; } }
    return m;
  }
  const seg = (ctx, pts, m, i, back) => { const a = pts[i], b = pts[i + 1], h = b.x - a.x; if (back) ctx.bezierCurveTo(b.x - h / 3, b.y - m[i + 1] * h / 3, a.x + h / 3, a.y + m[i] * h / 3, a.x, a.y); else ctx.bezierCurveTo(a.x + h / 3, a.y + m[i] * h / 3, b.x - h / 3, b.y - m[i + 1] * h / 3, b.x, b.y); };
  function setupCanvas(c, H) { const dpr = window.devicePixelRatio || 1, W = c.clientWidth || 1200; c.width = W * dpr; c.height = H * dpr; const ctx = c.getContext('2d'); ctx.scale(dpr, dpr); return { ctx, W, H }; }
  const tf = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function draw(series, band) {
    const css = getComputedStyle(document.documentElement), col = v => css.getPropertyValue(v).trim();
    const mono = col('--mono'), sans = col('--sans');
    const cMain = $('chart'), cSpread = $('spread');
    const main = setupCanvas(cMain, cMain.clientHeight || 300), sp = setupCanvas(cSpread, cSpread.clientHeight || 96);
    const { ctx, W, H } = main;
    ctx.clearRect(0, 0, W, H); sp.ctx.clearRect(0, 0, sp.W, sp.H);
    const padL = 12, padR = 84, padT = 22, padB = 26;
    // one sample or none: a fresh coin gets its first point ~15 s after both venues read and its second 15 s later — say so meanwhile (no coin at all: still waiting for the launch)
    if (series.length < 2) { ctx.fillStyle = col('--dim'); ctx.font = '13px ' + sans; ctx.fillText(series.length || state?.coin ? 'collecting the first minutes…' : 'waiting for launch', padL, H / 2); chartGeom = null; tipEl.hidden = true; return; }
    const t0 = series[0].t, t1 = series[series.length - 1].t, vals = series.flatMap(p => [p.pump, p.pons]);
    let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.12 || hi * 0.05 || 1; lo -= pad; hi += pad;   // two equal samples still get a band to draw in
    const x = t => padL + (t - t0) / Math.max(1, t1 - t0) * (W - padL - padR), y = v => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    // grid: hairlines with the value sitting just above each one, on the left, out of the way of the live tags on the right
    ctx.strokeStyle = col('--line'); ctx.lineWidth = 1; ctx.fillStyle = col('--dim'); ctx.font = '11px ' + mono; ctx.textAlign = 'left';
    for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4, yy = Math.round(y(v)) + .5; ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR + 6, yy); ctx.stroke(); if (i) ctx.fillText(fmtUsd(v), padL + 2, yy - 5); }
    // time ticks
    const span = t1 - t0, step = span > 20 * 3600e3 ? 4 * 3600e3 : span > 5 * 3600e3 ? 3600e3 : span > 90 * 60e3 ? 15 * 60e3 : span > 25 * 60e3 ? 5 * 60e3 : 2 * 60e3;
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) { const xx = Math.round(x(t)) + .5; ctx.strokeStyle = col('--line'); ctx.beginPath(); ctx.moveTo(xx, H - padB); ctx.lineTo(xx, H - padB + 4); ctx.stroke(); const s = tf(t), w = ctx.measureText(s).width; if (xx + w / 2 < W - padR && xx - w / 2 > padL) ctx.fillText(s, xx - w / 2, H - 8); }
    const P = series.map(p => ({ x: x(p.t), yp: y(p.pump), yq: y(p.pons), t: p.t, pump: p.pump, pons: p.pons }));
    const top = P.map(p => ({ x: p.x, y: p.yp })), bot = P.map(p => ({ x: p.x, y: p.yq })), mt = tangents(top), mb = tangents(bot);
    // the ribbon between the two lines, built from the same curves: purple where pump.fun runs ahead, green where PONS does; faint inside the band, solid outside
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], g = Math.max(a.pump, a.pons) / Math.min(a.pump, a.pons) - 1, ahead = a.pump >= a.pons ? 'sol' : 'rh';
      ctx.fillStyle = ahead === 'sol' ? (g <= band ? 'rgba(153,69,255,.10)' : 'rgba(153,69,255,.24)') : (g <= band ? 'rgba(0,200,5,.09)' : 'rgba(0,200,5,.22)');
      ctx.beginPath(); ctx.moveTo(top[i].x, top[i].y); seg(ctx, top, mt, i, false); ctx.lineTo(bot[i + 1].x, bot[i + 1].y); seg(ctx, bot, mb, i, true); ctx.closePath(); ctx.fill();
    }
    // the two lines, their live ends with a soft glow, and a value tag each (tags pushed apart when the lines end together)
    const tagY = {}; { const yp = Math.max(padT + 9, Math.min(H - padB - 9, top[top.length - 1].y)), yq = Math.max(padT + 9, Math.min(H - padB - 9, bot[bot.length - 1].y)); if (Math.abs(yp - yq) < 20) { const mid = (yp + yq) / 2, up = yp <= yq; tagY.pump = mid + (up ? -10 : 10); tagY.pons = mid + (up ? 10 : -10); } else { tagY.pump = yp; tagY.pons = yq; } }
    for (const [key, pts, m, color, tagFill] of [['pump', top, mt, col('--sol'), '#b98bff'], ['pons', bot, mb, col('--rh'), '#3ddb4a']]) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.75; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (let i = 0; i < pts.length - 1; i++) seg(ctx, pts, m, i, false); ctx.stroke();
      const last = pts[pts.length - 1];
      ctx.fillStyle = color; ctx.globalAlpha = .22; ctx.beginPath(); ctx.arc(last.x, last.y, 8, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2); ctx.fill();
      const label = fmtUsd(series[series.length - 1][key]); ctx.font = '500 11px ' + mono; const tw = ctx.measureText(label).width + 12, ty = tagY[key];
      ctx.fillStyle = tagFill; ctx.beginPath(); ctx.roundRect(W - padR + 10, ty - 9, tw, 18, 4); ctx.fill(); ctx.fillStyle = '#000'; ctx.textAlign = 'left'; ctx.fillText(label, W - padR + 16, ty + 4);
    }
    // spread: the gap over time as an area, lime inside the band, red outside, the band as a dashed hairline
    const S = sp, sTop = 16, sBot = 8, sH = S.H - sTop - sBot, gaps = series.map(p => Math.max(p.pump, p.pons) / Math.min(p.pump, p.pons) - 1), gmax = Math.max(band * 1.5, Math.max(...gaps) * 1.15);
    const gy = g => sTop + (1 - Math.min(g, gmax) / gmax) * sH;
    const sx = t => padL + (t - t0) / Math.max(1, t1 - t0) * (S.W - padL - padR);
    S.ctx.fillStyle = col('--dim'); S.ctx.font = '11px ' + sans; S.ctx.textAlign = 'left'; S.ctx.fillText('spread between the two market caps', padL + 2, 11);
    S.ctx.strokeStyle = col('--line'); S.ctx.lineWidth = 1; S.ctx.beginPath(); S.ctx.moveTo(padL, Math.round(gy(0)) + .5); S.ctx.lineTo(S.W - padR + 6, Math.round(gy(0)) + .5); S.ctx.stroke();
    const by = Math.round(gy(band)) + .5; S.ctx.setLineDash([3, 4]); S.ctx.strokeStyle = 'rgba(198,232,20,.55)'; S.ctx.beginPath(); S.ctx.moveTo(padL, by); S.ctx.lineTo(S.W - padR + 6, by); S.ctx.stroke(); S.ctx.setLineDash([]);
    S.ctx.fillStyle = col('--dim'); S.ctx.font = '11px ' + mono; S.ctx.textAlign = 'right'; S.ctx.fillText((band * 100).toFixed(0) + '% band', S.W - 4, by + 4);
    for (let i = 1; i < series.length; i++) {
      const a = series[i - 1], b = series[i], inside = gaps[i - 1] <= band && gaps[i] <= band;
      S.ctx.fillStyle = inside ? 'rgba(198,232,20,.22)' : 'rgba(255,92,92,.26)';
      S.ctx.beginPath(); S.ctx.moveTo(sx(a.t), gy(0)); S.ctx.lineTo(sx(a.t), gy(gaps[i - 1])); S.ctx.lineTo(sx(b.t), gy(gaps[i])); S.ctx.lineTo(sx(b.t), gy(0)); S.ctx.closePath(); S.ctx.fill();
    }
    S.ctx.lineWidth = 1.5; S.ctx.lineJoin = 'round';
    for (let i = 1; i < series.length; i++) { const a = series[i - 1], b = series[i]; S.ctx.strokeStyle = gaps[i] <= band ? col('--ok') : col('--bad'); S.ctx.beginPath(); S.ctx.moveTo(sx(a.t), gy(gaps[i - 1])); S.ctx.lineTo(sx(b.t), gy(gaps[i])); S.ctx.stroke(); }
    const gl = gaps[gaps.length - 1], glab = (gl * 100).toFixed(2) + '%'; S.ctx.font = '500 11px ' + mono; const gw = S.ctx.measureText(glab).width + 12, gyy = Math.max(sTop + 9, Math.min(S.H - sBot - 9, gy(gl)));
    S.ctx.fillStyle = gl <= band ? col('--ok') : col('--bad'); S.ctx.beginPath(); S.ctx.roundRect(S.W - padR + 10, gyy - 9, gw, 18, 4); S.ctx.fill(); S.ctx.fillStyle = '#000'; S.ctx.textAlign = 'left'; S.ctx.fillText(glab, S.W - padR + 16, gyy + 4);
    chartGeom = { P, padL, padR, W, H, band };
  }
  // hover: nearest sample, a hairline over both panes and a small readout
  (() => {
    const wrap = $('chart').parentElement, over = document.createElement('canvas'); over.style.cssText = 'position:absolute;inset:0;pointer-events:none'; over.className = 'over'; wrap.appendChild(over);
    const clear = () => { const o = over.getContext('2d'); o.clearRect(0, 0, over.width, over.height); tipEl.hidden = true; };
    wrap.addEventListener('mousemove', e => {
      if (!chartGeom) return; const r = wrap.getBoundingClientRect(), mx = e.clientX - r.left; const { P, padL, W, padR } = chartGeom; if (mx < padL || mx > W - padR) return clear();
      let best = P[0]; for (const p of P) if (Math.abs(p.x - mx) < Math.abs(best.x - mx)) best = p;
      const dpr = window.devicePixelRatio || 1; over.width = r.width * dpr; over.height = r.height * dpr; const o = over.getContext('2d'); o.scale(dpr, dpr); o.clearRect(0, 0, r.width, r.height);
      o.strokeStyle = 'rgba(255,255,255,.22)'; o.lineWidth = 1; o.setLineDash([2, 3]); o.beginPath(); o.moveTo(Math.round(best.x) + .5, 0); o.lineTo(Math.round(best.x) + .5, r.height); o.stroke(); o.setLineDash([]);
      for (const [yy, c] of [[best.yp, '#9945ff'], [best.yq, '#00c805']]) { o.fillStyle = '#000'; o.beginPath(); o.arc(best.x, yy, 4.5, 0, Math.PI * 2); o.fill(); o.fillStyle = c; o.beginPath(); o.arc(best.x, yy, 3, 0, Math.PI * 2); o.fill(); }
      const g = Math.max(best.pump, best.pons) / Math.min(best.pump, best.pons) - 1;
      tipEl.innerHTML = `${tf(best.t)} · <span class="s">pump.fun <b>${fmtUsd(best.pump)}</b></span> · <span class="r">PONS <b>${fmtUsd(best.pons)}</b></span> · spread <b>${(g * 100).toFixed(2)}%</b>`;
      tipEl.hidden = false; const tw = tipEl.offsetWidth; tipEl.style.left = Math.max(tw / 2 + 4, Math.min(r.width - tw / 2 - 4, best.x)) + 'px';
    });
    wrap.addEventListener('mouseleave', clear);
  })();

  // ---- cards ----
  const auctionCard = (a, featured) => { const s = a.bySide || {}, ps = Math.min(100, s.sol / a.targetUsd * 100), pr = Math.min(100 - ps, s.rh / a.targetUsd * 100);
    return `<a class="card${featured ? ' featured' : ''}" href="/a/${a.id}" data-nav>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">${ident(a)}<span style="display:flex;gap:6px;align-items:center">${a.curve && a.status === 'open' ? `<span class="gapchip ok">cap ${fmtUsd(a.curve.cap)}</span>` : ''}<span class="state ${a.status}">${stateText(a)}</span></span></div>
      <div class="raise"><span class="num" style="font-family:var(--mono);font-size:24px;font-weight:500">${fmtUsdFull(a.raisedUsd)}</span><span class="of">${a.pair && a.pair !== 'SOL' ? `<b style="color:var(--ok)">${esc(a.pair)}-quoted</b> · ` : ''}of ${fmtUsdFull(a.targetUsd)} · ${a.pct}%</span></div>
      <div class="fill" aria-hidden="true"><i class="s" style="width:${ps}%"></i><i class="r" style="width:${pr}%"></i></div>
      <div class="meta"><span>${a.contributors} contributor${a.contributors === 1 ? '' : 's'}${a.status === 'live' && coinCaps.get(a.id) ? ` · <span class="cap">${fmtUsd(coinCaps.get(a.id))} cap</span>` : ''}</span><span>${a.status === 'open' ? timeLeft(a.deadline) : a.status === 'live' && a.launch?.launchedAt ? 'launched ' + ago(a.launch.launchedAt) : ago(a.createdAt)}</span></div></a>`; };
  const coinCaps = new Map(), coinSides = new Map();   // auction id → the launched coin's market cap (the higher side) / both sides, from /api/coins
  const noteCoins = coins => { for (const c of coins) { if (c.pump?.fdv || c.pons?.fdv) coinCaps.set(c.id, Math.max(c.pump?.fdv || 0, c.pons?.fdv || 0)); coinSides.set(c.id, { pump: c.pump?.fdv ?? null, pons: c.pons?.fdv ?? null }); } };
  const coinCard = c => `<a class="card" href="${c.id === 'twine' ? '/' : '/c/' + c.id}" data-nav>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">${ident(c)}${c.gap != null ? `<span class="gapchip ${c.inBand ? 'ok' : 'bad'}">${(c.gap * 100).toFixed(2)}% apart</span>` : ''}</div>
      <div class="pair"><div><span class="label" style="--sw:var(--sol)">pump.fun</span><span class="n">${c.pump ? fmtUsd(c.pump.fdv) : '—'}</span></div><div><span class="label" style="--sw:var(--rh)">PONS</span><span class="n">${c.pons ? fmtUsd(c.pons.fdv) : '—'}</span></div></div>
      <div class="meta"><span>${c.pump?.phaseLabel ?? ''}</span><span>${c.launchedAt ? 'launched ' + ago(c.launchedAt) : ''}</span></div></a>`;

  // ---- auction detail ----
  function renderAuction(a) {
    document.title = `$${a.symbol} auction · Twine`;
    $('a-head').innerHTML = ident(a, true).replace(/^<div class="ahead">|<\/div>$/g, '');
    const st = $('a-state'); st.className = 'state ' + a.status; st.textContent = stateText(a);
    setText('a-time', a.status === 'open' ? timeLeft(a.deadline) : a.filledAt ? 'filled ' + ago(a.filledAt) : 'ended ' + ago(a.deadline));
    setText('a-raised', fmtUsdFull(a.raisedUsd)); setText('a-target', fmtUsdFull(a.targetUsd)); setText('a-pct', a.pct + '%');
    $('a-pair').hidden = !(a.pair && a.pair !== 'SOL'); if (a.pair && a.pair !== 'SOL') setText('a-pair', `Stock pair: both coins are quoted in ${a.pair} (the xStock on pump.fun, the Robinhood token on PONS). Contributions are still SOL and ETH; the makers convert them at launch.`);
    const s = a.bySide || {}, ps = Math.min(100, s.sol / a.targetUsd * 100), pr = Math.min(100 - ps, s.rh / a.targetUsd * 100); $('a-fill-s').style.width = ps + '%'; $('a-fill-r').style.width = pr + '%';
    setText('a-sol', (s.solAmount ?? 0).toFixed(3) + ' SOL'); setText('a-eth', (s.ethAmount ?? 0).toFixed(4) + ' ETH'); setText('a-contrib', String(a.contributors));
    setText('a-open', a.launch?.openingFdv ? fmtUsd(a.launch.openingFdv) : a.estimate?.openingFdv ? fmtUsd(a.estimate.openingFdv) + ' now' : a.estimate?.atTarget ? fmtUsd(a.estimate.atTarget.openingFdv) + ' at target' : '—');
    setText('a-desc', a.description || ''); $('a-desc').hidden = !a.description;
    $('a-links').innerHTML = [['X', a.twitter], ['Telegram', a.telegram], ['Website', a.website]].filter(x => x[1]).map(([l, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener" style="color:var(--muted);border-bottom:1px dotted var(--dim)">${l}</a>`).join('');
    const open = a.status === 'open' && !a.paused;
    $('a-deposits').hidden = !open || Boolean(a.curve); $('a-warn').hidden = !open || Boolean(a.curve); $('a-paused').hidden = !(a.paused && a.status === 'open');
    setText('a-dep-sol', a.deposits.sol); setText('a-dep-rh', a.deposits.rh);
    const L = a.launch; $('a-launch').hidden = !(L && (L.pumpMint || L.steps?.length));
    if (L) {
      setText('a-ca-pump', L.pumpMint ?? 'pending'); setText('a-ca-pons', L.ponsToken ?? L.ponsCurve ?? 'pending');
      const RL = a.previousLaunches || []; $('a-relaunch').hidden = !RL.length;
      if (RL.length) setText('a-relaunch', `Relaunched: the first deployment was scrapped after its Solana allocation buy failed to land, and the coin was launched again for the same contributors with the corrected allocation. The addresses above are the live coin. Old contracts (no longer supported): pump.fun ${RL.map(p => p.pumpMint).filter(Boolean).join(', ') || '—'} · PONS ${RL.map(p => p.ponsToken).filter(Boolean).join(', ') || '—'}.`);
      $('a-view-coin').hidden = !a.coinId; if (a.coinId) $('a-view-coin').setAttribute('href', '/c/' + a.coinId);
      const names = { deposits: 'Deposits counted', bridge_rh_to_sol: 'Bridged ETH → SOL for the maker', bridge_sol_to_rh: 'Bridged SOL → ETH for the maker', sizing: 'Opening price fixed', funded: 'Wallets funded', engine_armed: 'Market maker armed', launched: 'Launched on both chains', distribution_error: 'Allocation problem' };
      $('a-steps').innerHTML = (L.steps || []).map(s => `<li><span class="t">${new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span class="${s.name === 'distribution_error' ? '' : 'done'}">${names[s.name] ?? s.name}${s.openingFdv && s.name === 'sizing' ? ' at ' + fmtUsd(s.openingFdv) : ''}${s.error ? ': ' + esc(s.error) : ''}</span></li>`).join('');
      const P = a.payouts || []; setText('a-dist', P.length ? `Allocations sent: ${P.filter(x => x.chain === 'sol').length} on Solana, ${P.filter(x => x.chain === 'rh').length} on Robinhood Chain${L.distributedAt ? '' : ' (in progress)'}${P.some(x => x.correction) ? ' · includes top-ups that corrected earlier short payouts' : ''}.` : (L.pumpMint ? 'Sending allocations to contributors…' : ''));
      $('a-payouts-wrap').hidden = !P.length;
      $('a-payouts').innerHTML = P.map(x => `<tr${x.correction ? ' title="top-up correcting an earlier short payout"' : ''}><td><span class="dot" style="background:var(--${x.chain === 'sol' ? 'sol' : 'rh'})"></span>${x.chain === 'sol' ? 'Solana' : 'Robinhood'}</td><td class="num"><a href="${x.chain === 'sol' ? 'https://solscan.io/account/' : 'https://robinhoodchain.blockscout.com/address/'}${esc(x.to)}" target="_blank" rel="noopener">${short(x.to)}</a></td><td class="r num">${x.tokens >= 1e6 ? (x.tokens / 1e6).toFixed(3) + 'M' : Math.round(x.tokens).toLocaleString('en-US')}${x.correction ? ' <span class="label" style="font-size:9px">top-up</span>' : ''}</td><td><a href="${x.chain === 'sol' ? 'https://solscan.io/tx/' : 'https://robinhoodchain.blockscout.com/tx/'}${esc(x.tx)}" target="_blank" rel="noopener">${short(x.tx)}</a></td></tr>`).join('');
    }
    const R = a.refunds; $('a-refunds').hidden = !R;
    if (R) { const all = [...R.sol, ...R.rh], ok = all.filter(r => r.refundTx).length, bad = all.filter(r => r.error).length; setText('a-refund-text', `${ok} of ${all.length} contributions refunded to their senders${bad ? `, ${bad} failed (we will retry)` : ''}.`); }
    $('a-error').hidden = !a.error; setText('a-error-text', a.error ? a.error + (a.diagnosis ? ' ' + a.diagnosis : '') : '');
    setText('a-contrib-note', a.contributions.length ? `last ${a.contributions.length}` : 'none yet');
    $('a-rows').innerHTML = a.contributions.length ? a.contributions.map(c => `<tr${c.late ? ' style="opacity:.55" title="' + (c.overCap ? 'over the wallet cap; refunded' : c.overSide ? "this chain's share of the raise was already full; refunded" : 'arrived after the fill; refunded') + '"' : ''}><td><span class="dot" style="background:var(--${c.chain === 'sol' ? 'sol' : 'rh'})"></span>${c.chain === 'sol' ? 'Solana' : 'Robinhood'}</td><td class="num"><a href="${c.chain === 'sol' ? 'https://solscan.io/account/' : 'https://robinhoodchain.blockscout.com/address/'}${esc(c.from)}" target="_blank" rel="noopener">${short(c.from)}</a></td><td class="r num">${c.chain === 'sol' ? c.amount.toFixed(3) + ' SOL' : c.amount.toFixed(4) + ' ETH'}</td><td class="r num">${c.late && !c.usd && !c.sale ? '<span class="label" title="not counted; refunded to the sender">refunded</span>' : c.sale ? '' : fmtUsdFull(c.usd)}</td><td>${ago(c.at)}</td><td><a href="${c.chain === 'sol' ? 'https://solscan.io/tx/' : 'https://robinhoodchain.blockscout.com/tx/'}${esc(c.tx)}" target="_blank" rel="noopener">${short(c.tx)}</a></td></tr>`).join('') : '<tr><td colspan="6" style="color:var(--dim)">Be the first.</td></tr>';
    renderCurve(a);
    const e = a.estimate?.atTarget; setText('a-est-open', e ? fmtUsd(e.openingFdv) : '—'); setText('a-est-cash', e ? fmtUsdFull(e.cashUsd) : '—'); setText('a-est-alloc', e ? fmtUsdFull(e.allocationUsd) + ' (1:1)' : '—'); setText('a-est-cap', a.walletCapUsd ? fmtUsdFull(a.walletCapUsd) : '—'); setText('a-est-side', a.sideCapUsd ? fmtUsdFull(a.sideCapUsd) : '—'); setText('a-deadline', new Date(a.deadline).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
  }

  // ---- the tradeable raise: price block, quote, tape, position and sell, demo deposits ----
  let curveAuction = null, quoteTimer = null;
  const b58 = bytes => { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b) break; s = '1' + s; } return s; };
  const fmtShares = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
  const fmtPx = p => p >= 0.01 ? '$' + p.toFixed(4) : '$' + p.toPrecision(3);
  function drawCurve(c) {
    const W = 600, H = 160, L = c.line || [], caps = L.map(p => p.cap), lo = Math.min(...caps) * 0.97, hi = Math.max(...caps) * 1.02;
    const X = x => x / c.targetUsd * W, Y = v => H - 8 - (v - lo) / (hi - lo) * (H - 20);
    const path = L.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.cap).toFixed(1)).join(' ');
    const xr = X(Math.min(c.reserveUsd, c.targetUsd)), filled = L.filter(p => p.x <= c.reserveUsd);
    const area = filled.length > 1 ? 'M' + X(filled[0].x).toFixed(1) + ' ' + (H - 8) + ' ' + filled.map(p => 'L' + X(p.x).toFixed(1) + ' ' + Y(p.cap).toFixed(1)).join(' ') + ' L' + xr.toFixed(1) + ' ' + (H - 8) + ' Z' : '';
    $('c-chart').innerHTML = `<defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(198,232,20,.35)"/><stop offset="1" stop-color="rgba(198,232,20,0)"/></linearGradient></defs>
      <path d="${area}" fill="url(#cg)"/><path d="${path}" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
      ${filled.length > 1 ? `<path d="${filled.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.cap).toFixed(1)).join(' ')}" fill="none" stroke="#c6e814" stroke-width="2" vector-effect="non-scaling-stroke"/>` : ''}
      <line x1="${xr.toFixed(1)}" y1="6" x2="${xr.toFixed(1)}" y2="${H - 8}" stroke="rgba(255,255,255,.35)" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/><circle cx="${xr.toFixed(1)}" cy="${Y(c.cap).toFixed(1)}" r="4" fill="#c6e814"/>`;
  }
  function renderCurve(a) {
    curveAuction = a; const c = a.curve; $('a-curve').hidden = !c; renderTerminal(a);
    if (!c) return;
    $('c-price').innerHTML = fmtPx(c.price) + `<small>per share</small>`; setText('c-cap', fmtUsd(c.cap)); $('c-buys').innerHTML = fmtShares(c.sharesPer100Usd) + `<small>shares${c.launchValuePer100Usd != null ? ' · worth $' + c.launchValuePer100Usd.toFixed(0) + ' at launch' : ''}</small>`; setText('c-fee', (c.feeBps / 100) + '%');
    setText('c-floor', fmtUsd(c.floorCap)); setText('c-top', fmtUsd(c.targetCap)); setText('c-here', `reserve ${fmtUsdFull(c.reserveUsd)} · ${c.pct}% · ${c.trades} trade${c.trades === 1 ? '' : 's'} · $${Math.round(c.volumeUsd).toLocaleString('en-US')} volume`); setText('c-capnote', c.walletCapPct + '% (' + fmtShares(c.walletCapShares) + ' of the ' + fmtShares(c.walletCapShares / (c.walletCapPct / 100)) + ' shares sold by the fill)');
    drawCurve(c);
    $('c-tape').innerHTML = (c.tape || []).length ? c.tape.map(t => `<div><span>${new Date(t.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span class="${t.side}">${t.side}</span><span>${t.chain === 'sol' ? 'Solana' : 'Robinhood'} ${esc(String(t.from).slice(0, 6))}…</span><span>${fmtShares(t.shares)} sh</span><span>$${t.usd.toFixed(0)}</span></div>`).join('') : '<div style="grid-template-columns:1fr;color:var(--dim)">no trades yet</div>';
    quoteNow();
    [...$('a-rows').rows].forEach((tr, i) => { const x = a.contributions[i]; if (!x) return; if (x.sale) { tr.title = 'sold back to the curve'; if (tr.cells[3]) tr.cells[3].innerHTML = `<span class="bonus" style="color:var(--bad)">sold ${fmtShares(x.shares || 0)} sh${x.saleUsd != null ? ' → ' + fmtUsdFull(x.saleUsd) : ''}</span>`; } else if (x.shares && !x.late && tr.cells[3]) tr.cells[3].innerHTML += `<span class="bonus">${fmtShares(x.shares)} sh @ ${fmtPx(x.priceUsd || 0)}</span>`; });
  }
  async function quoteNow() { const a = curveAuction; if (!a?.curve) return; const usd = Number($('q-usd').value); if (!(usd >= 5)) { setText('q-out', '—'); return; } try { const j = await get(`/api/auctions/${a.id}/quote?usd=${usd}`); setText('q-out', `${fmtShares(j.shares)} shares (${((j.launchValueUsd / usd - 1) * 100).toFixed(0) >= 0 ? '+' : ''}${((j.launchValueUsd / usd - 1) * 100).toFixed(0)}% vs your deposit at launch) · cap after ${fmtUsd(j.capAfter)}`); } catch { setText('q-out', '—'); } }
  $('q-usd').addEventListener('input', () => { clearTimeout(quoteTimer); quoteTimer = setTimeout(quoteNow, 250); });
  // ---- the trading terminal: wallet connect, buy (a wallet-signed transfer to the deposit address), sell (one signed line) ----
  const DEMO_ADDR = { sol: 'DemoSo1anaWa11et1111111111111111111111111111', rh: '0x00000000000000000000000000000000000dem0' };
  const RH_CHAIN = { chainId: '0x1237', chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'], blockExplorerUrls: ['https://robinhoodchain.blockscout.com'] };
  const PRESETS = { sol: [0.1, 0.25, 0.5, 1], rh: [0.01, 0.025, 0.05, 0.1] };
  const asset = chain => chain === 'sol' ? 'SOL' : 'ETH', fxOf = (a, chain) => (a?.fx ?? lastFx)?.[asset(chain)] ?? null;
  let W = null, tSide = 'buy', tPos = null, tBusy = false, termInit = false, tRefreshedAt = 0, tTimer = null, web3Loading = null;
  const tErr = m => { const e = $('t-err'); e.hidden = !m; e.textContent = m || ''; }, tOk = m => { const e = $('t-ok'); e.hidden = !m; e.innerHTML = m || ''; };
  const toHex = s => '0x' + [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, '0')).join('');
  function setSide(side, animate = true) {
    tSide = side; $('t-buy').hidden = side !== 'buy'; $('t-sell').hidden = side !== 'sell';
    const bar = $('t-tabs'); bar.querySelectorAll('.seg-btn').forEach(b => b.setAttribute('aria-selected', String(b.dataset.side === side)));
    const btn = bar.querySelector('[data-side="' + side + '"]'), ind = bar.querySelector('.seg-ind'); if (btn && ind && btn.offsetWidth) { ind.style.transition = animate ? '' : 'none'; ind.style.width = btn.offsetWidth + 'px'; ind.style.transform = 'translateX(' + (btn.offsetLeft - 3) + 'px)'; if (!animate) void ind.offsetWidth; ind.style.transition = ''; }
    tErr(''); if (side === 'buy') quoteBuy(); else quoteSell();
  }
  async function ensureRhChain(e) { try { await e.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RH_CHAIN.chainId }] }); } catch (err) { if (err?.code === 4902 || /unrecognized|not added|4902/i.test(err?.message || '')) await e.request({ method: 'wallet_addEthereumChain', params: [RH_CHAIN] }); else throw err; } }
  async function connect(chain, demo = false, silent = false) {
    tErr('');
    try {
      if (demo) W = { chain, address: DEMO_ADDR[chain], demo: true, provider: null };
      else if (chain === 'sol') {
        const p = window.phantom?.solana ?? window.solana; if (!p?.connect) { if (silent) return; throw Error('No Solana wallet found. Install Phantom (phantom.app) or Solflare, or send manually below.'); }
        const r = await p.connect(silent ? { onlyIfTrusted: true } : undefined); W = { chain, address: r.publicKey.toString(), demo: false, provider: p };
        if (!p.__twine) { p.__twine = true; p.on?.('accountChanged', pk => { if (W?.chain === 'sol' && !W.demo) { if (pk) { W.address = pk.toString(); tPos = null; refreshWallet(true); renderWallet(); } else disconnect(); } }); p.on?.('disconnect', () => { if (W?.chain === 'sol' && !W.demo) disconnect(); }); }
      } else {
        const e = window.ethereum; if (!e?.request) { if (silent) return; throw Error('No EVM wallet found. Install MetaMask or Rabby, or send manually below.'); }
        const accts = await e.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' }); if (!accts?.[0]) { if (silent) return; throw Error('the wallet did not share an account'); }
        if (!silent) await ensureRhChain(e); W = { chain, address: accts[0], demo: false, provider: e };
        if (!e.__twine) { e.__twine = true; e.on?.('accountsChanged', a => { if (W?.chain === 'rh' && !W.demo) { if (a?.[0]) { W.address = a[0]; tPos = null; refreshWallet(true); renderWallet(); } else disconnect(); } }); }
      }
      try { localStorage.setItem('twine.wallet', JSON.stringify({ chain, demo })); } catch {}
      renderWallet(); await refreshWallet(true); setSide(tSide, false);
    } catch (e) { W = null; renderWallet(); renderPosition(); if (!silent) tErr(e?.message || String(e)); }
  }
  function disconnect() { const p = W?.provider; W = null; tPos = null; try { localStorage.removeItem('twine.wallet'); } catch {} try { if (p?.disconnect && p.isPhantom) p.disconnect(); } catch {} renderWallet(); renderPosition(); setSide(tSide, false); }
  function renderWallet() {
    const a = curveAuction, on = Boolean(W); $('t-connect').hidden = on; $('t-connected').hidden = !on;
    if (!on) { setText('t-unit', 'SOL'); $('t-presets').innerHTML = ''; return; }
    $('t-dot').style.background = 'var(--' + W.chain + ')'; setText('t-chain', W.chain === 'sol' ? 'Solana' : 'Robinhood Chain'); setText('t-addr', (W.demo ? 'demo · ' : '') + short(W.address)); setText('t-unit', asset(W.chain));
    setText('t-bal', W.demo ? 'demo funds' : W.balance == null ? '' : W.balance.toFixed(W.chain === 'sol' ? 3 : 4) + ' ' + asset(W.chain));
    if ($('t-presets').dataset.chain !== W.chain) { $('t-presets').dataset.chain = W.chain; $('t-presets').innerHTML = PRESETS[W.chain].map(v => '<button type="button" data-amt="' + v + '">' + v + ' ' + asset(W.chain) + '</button>').join(''); }
  }
  async function refreshWallet(force = false) {
    const a = curveAuction; if (!W || !a) return; if (!force && Date.now() - tRefreshedAt < 2500) return; tRefreshedAt = Date.now();
    const me = W;
    const [bal, pos] = await Promise.all([me.demo ? Promise.resolve({ amount: null }) : get('/api/chain/balance?chain=' + me.chain + '&address=' + encodeURIComponent(me.address)).catch(() => ({ amount: null })), get('/api/auctions/' + a.id + '/position?chain=' + me.chain + '&address=' + encodeURIComponent(me.address)).catch(() => ({ position: null }))]);
    if (W !== me) return; W.balance = bal.amount; tPos = pos.position; renderWallet(); renderPosition();
  }
  function renderPosition() {
    const p = tPos, on = Boolean(W); $('t-pos').hidden = !on; if (!on) return;
    const n = $('tp-now');
    if (!p || !(p.shares > 0)) { setText('tp-shares', '0'); setText('tp-cost', '—'); n.textContent = '—'; n.className = 'n'; setText('tp-launch', '—'); return; }
    const net = Math.max(0, (p.costUsd ?? 0) - (p.soldUsd ?? 0));
    setText('tp-shares', fmtShares(p.shares) + ' · ' + p.supplyPct + '% of the raise'); setText('tp-cost', fmtUsdFull(net));
    n.textContent = fmtUsdFull(p.valueNowUsd) + (net > 0 ? ' (' + (p.valueNowUsd >= net ? '+' : '') + ((p.valueNowUsd / net - 1) * 100).toFixed(1) + '%)' : ''); n.className = 'n ' + (p.valueNowUsd >= net ? 'up' : 'down'); setText('tp-launch', fmtUsdFull(p.launchValueUsd));
  }
  async function quoteBuy() {
    const a = curveAuction, box = $('t-bquote'), go = $('t-buy-go'); go.disabled = true; go.textContent = 'Buy';
    if (!a?.curve) return; if (!W) { box.textContent = 'connect a wallet to buy'; return; }
    const amt = Number($('t-amt').value), px = fxOf(a, W.chain);
    if (!(amt > 0)) { box.textContent = 'enter an amount in ' + asset(W.chain) + (px ? ' · 1 ' + asset(W.chain) + ' ≈ ' + fmtUsdFull(px) : ''); return; }
    if (!px) { box.textContent = 'no price feed yet, try again in a moment'; return; }
    const usd = amt * px; if (usd < 5) { box.textContent = '≈ ' + fmtUsdFull(usd) + ' · the minimum is $5'; return; }
    try {
      const j = await get('/api/auctions/' + a.id + '/quote?usd=' + usd.toFixed(2)); if (W?.chain == null) return;
      const cap = a.curve.walletCapShares || Infinity, room = Math.max(0, cap - (tPos?.shares || 0)), gain = (j.launchValueUsd / usd - 1) * 100;
      box.innerHTML = '≈ ' + fmtUsdFull(usd) + ' → <b>' + fmtShares(j.shares) + ' shares</b> · avg ' + fmtPx(usd / j.shares) + ' · ' + (gain >= 0 ? '+' : '') + gain.toFixed(0) + '% vs your deposit at launch · cap after ' + fmtUsd(j.capAfter) + (isFinite(cap) ? ' · room left ' + fmtShares(room) + ' sh' : '');
      if (j.shares > room + 1) { box.innerHTML += '<br><span class="err">over your wallet cap: this wallet can add at most ' + fmtShares(room) + ' more shares (' + a.curve.walletCapPct + '% of the raise per wallet); the excess would be refunded, so the buy is blocked here.</span>'; return; }
      if (!W.demo && W.balance != null && amt > W.balance - (W.chain === 'sol' ? 0.002 : 0.0002)) { box.innerHTML += '<br><span class="err">not enough ' + asset(W.chain) + ' in the wallet (' + W.balance.toFixed(4) + ')</span>'; return; }
      go.disabled = !(a.status === 'open' && !a.paused); go.textContent = 'Buy · ' + amt + ' ' + asset(W.chain) + (a.demo ? ' (simulated)' : '');
    } catch { box.textContent = 'could not get a quote'; }
  }
  const loadWeb3 = () => { if (window.solanaWeb3) return Promise.resolve(window.solanaWeb3); web3Loading ??= new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/vendor/solana-web3.iife.min.js'; s.onload = () => res(window.solanaWeb3); s.onerror = () => { web3Loading = null; rej(Error('could not load the Solana library; send manually below')); }; document.head.appendChild(s); }); return web3Loading; };
  async function doBuy() {
    const a = curveAuction; if (!a || !W || tBusy) return; const amt = Number($('t-amt').value), px = fxOf(a, W.chain), usd = amt * px; tErr(''); tOk(''); tBusy = true; $('t-buy-go').disabled = true;
    try {
      if (a.demo) {   // simulated: credited to the connected address, nothing leaves the wallet
        const r = await fetch('/api/demo/contribute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: a.id, chain: W.chain, usd, from: W.address }) }); const j = await r.json(); if (!r.ok) throw Error(j.error || r.status);
        renderAuction({ ...a, ...j }); await refreshWallet(true); const c = (j.contributions || []).find(x => x.from === W.address && !x.late && !x.sale); tOk('Simulated: ' + amt + ' ' + asset(W.chain) + ' (' + fmtUsdFull(usd) + ') credited to ' + short(W.address) + (c ? ' · you now hold ' + fmtShares(tPos?.shares || 0) + ' shares' : '') + '. Nothing left your wallet.'); $('t-amt').value = '';
      } else if (W.chain === 'sol') {
        const web3 = await loadWeb3(); const { blockhash } = await get('/api/chain/blockhash'); const from = new web3.PublicKey(W.address);
        const tx = new web3.Transaction({ recentBlockhash: blockhash, feePayer: from }).add(web3.SystemProgram.transfer({ fromPubkey: from, toPubkey: new web3.PublicKey(a.deposits.sol), lamports: Math.round(amt * 1e9) }));
        const { signature } = await W.provider.signAndSendTransaction(tx);
        tOk('Sent ' + amt + ' SOL · <a href="https://solscan.io/tx/' + signature + '" target="_blank" rel="noopener">' + short(signature) + '</a> · waiting for it to be credited…'); $('t-amt').value = ''; watchCredit(signature, amt);
      } else {
        await ensureRhChain(W.provider); const wei = BigInt(Math.round(amt * 1e6)) * 10n ** 12n;
        const hash = await W.provider.request({ method: 'eth_sendTransaction', params: [{ from: W.address, to: a.deposits.rh, value: '0x' + wei.toString(16) }] });
        tOk('Sent ' + amt + ' ETH · <a href="https://robinhoodchain.blockscout.com/tx/' + hash + '" target="_blank" rel="noopener">' + short(hash) + '</a> · waiting for it to be credited…'); $('t-amt').value = ''; watchCredit(hash, amt);
      }
    } catch (e) { tErr(e?.message || String(e)); } finally { tBusy = false; quoteBuy(); }
  }
  function watchCredit(tx, amt) {
    const id = curveAuction.id, t0 = Date.now(); clearInterval(tTimer);
    tTimer = setInterval(async () => { try {
      const j = await get('/api/auctions/' + id); const c = (j.contributions || []).find(x => String(x.tx).toLowerCase() === String(tx).toLowerCase());
      if (c) { clearInterval(tTimer); renderAuction(j); await refreshWallet(true); tOk(c.late ? 'Your ' + amt + ' ' + asset(c.chain) + ' arrived but could not be counted (' + (c.overCap ? 'over the wallet cap' : c.overSide ? 'that side of the raise is full' : 'the raise had already filled') + '); it is being refunded to your wallet.' : 'Credited: <b>' + fmtShares(c.shares || 0) + ' shares</b> for ' + amt + ' ' + asset(c.chain) + '.'); quoteBuy(); }
      else if (Date.now() - t0 > 300000) { clearInterval(tTimer); tOk('Sent, but not credited after 5 minutes; it will appear in the contributions table when the watcher sees it. Your shares follow automatically.'); }
    } catch {} }, 3000);
  }
  async function quoteSell() {
    const a = curveAuction, box = $('t-squote'), go = $('t-sell-go'); go.disabled = true; go.textContent = 'Sign & sell';
    if (!a?.curve) return; if (!W) { box.textContent = 'connect a wallet to sell'; return; }
    if (!tPos || !(tPos.shares > 0)) { box.textContent = 'nothing to sell yet'; return; }
    const n = Number($('t-shares').value); if (!(n > 0)) { box.textContent = 'you hold ' + fmtShares(tPos.shares) + ' shares · enter how many to sell'; return; }
    if (n > tPos.shares + 1) { box.textContent = 'you only hold ' + fmtShares(tPos.shares) + ' shares'; return; }
    try {
      const j = await get('/api/auctions/' + a.id + '/quote?shares=' + Math.round(Math.min(n, tPos.shares))); if (!W) return; const px = fxOf(a, W.chain);
      box.innerHTML = '→ <b>' + fmtUsdFull(j.usd) + '</b> after the ' + (a.curve.feeBps / 100) + '% fee' + (px ? ' ≈ ' + (j.usd / px).toFixed(W.chain === 'sol' ? 4 : 5) + ' ' + asset(W.chain) : '') + ' · avg ' + fmtPx(j.usd / n) + ' · cap after ' + fmtUsd(j.capAfter);
      go.disabled = !(a.status === 'open' && !a.paused); go.textContent = (W.demo ? 'Sell ' : 'Sign & sell ') + fmtShares(n) + ' shares';
    } catch { box.textContent = 'could not get a quote'; }
  }
  async function doSell() {
    const a = curveAuction; if (!a || !W || !tPos || tBusy) return; const n = Number($('t-shares').value), shares = n >= tPos.shares - 1 ? 'all' : Math.round(n); tErr(''); tOk(''); tBusy = true; $('t-sell-go').disabled = true;
    try {
      let message = 'demo', signature = 'demo';
      if (!W.demo) {
        message = 'twine sell ' + a.id + ' ' + W.address + ' ' + Date.now();
        if (W.chain === 'sol') { const s = await W.provider.signMessage(new TextEncoder().encode(message), 'utf8'); signature = b58(s.signature); }
        else signature = await W.provider.request({ method: 'personal_sign', params: [toHex(message), W.address] });
      }
      const r = await fetch('/api/auctions/' + a.id + '/sell', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chain: W.chain, address: W.address, message, signature, shares }) }); const j = await r.json(); if (!r.ok) throw Error(j.error || r.status);
      renderAuction(j.auction); await refreshWallet(true); $('t-shares').value = '';
      tOk('Sold <b>' + fmtShares(j.shares) + ' shares</b> for ' + fmtUsdFull(j.usd) + ' → ' + j.amount + ' ' + j.asset + ' to ' + short(W.address) + (j.partial ? ' (partial: that side of the reserve could only pay this much right now; the rest of your position stays)' : '') + (j.pending ? ' · confirming' : '') + (j.failed ? ' · payout failed, it will retry' : '') + (a.demo ? (W.demo ? ' · demo: recorded, nothing sent.' : ' · demo: your signature was verified; the payout is recorded, not sent.') : '.'));
    } catch (e) { tErr(e?.message || String(e)); } finally { tBusy = false; quoteSell(); }
  }
  function renderTerminal(a) {
    const c = a.curve, term = $('a-term'); term.hidden = !c; if (!c) return;
    const open = a.status === 'open' && !a.paused; term.classList.toggle('closed', !open); $('t-closed').hidden = open;
    setText('t-closed', a.paused && a.status === 'open' ? 'Trading is paused with the auctions; positions are safe and trading resumes with them.' : ['filled', 'launching', 'live', 'launched'].includes(a.status) ? 'The raise filled: every share is becoming real tokens on its chain. Trading on the curve has ended.' : a.status === 'open' ? '' : 'This raise is closed; positions are refunded to their wallets.');
    setText('t-dep-sol', a.deposits.sol); setText('t-dep-rh', a.deposits.rh); $('t-demo-note').hidden = !a.demo; $('t-demo-sol').hidden = $('t-demo-rh').hidden = !a.demo;
    setText('t-fee', (c.feeBps / 100) + '% fee on every buy and sell, kept as the coin\'s maker cash · one wallet may hold at most ' + c.walletCapPct + '% of the raise: ' + fmtShares(c.walletCapShares) + ' of the ' + fmtShares(c.walletCapShares / (c.walletCapPct / 100)) + ' shares sold by the time it fills');
    if (!termInit) { termInit = true; let saved = null; try { saved = JSON.parse(localStorage.getItem('twine.wallet') || 'null'); } catch {} setSide('buy', false); if (saved?.chain) connect(saved.chain, Boolean(saved.demo), true); }
    else if (W) refreshWallet();
    renderWallet();
  }
  $('t-tabs').addEventListener('click', e => { const b = e.target.closest('.seg-btn'); if (b && b.dataset.side !== tSide) setSide(b.dataset.side); });
  $('t-connect').addEventListener('click', e => { const b = e.target.closest('[data-connect],[data-demo]'); if (!b) return; if (b.dataset.demo) connect(b.dataset.demo, true); else connect(b.dataset.connect); });
  $('t-disconnect').addEventListener('click', disconnect);
  let tQuoteTimer = null;
  $('t-amt').addEventListener('input', () => { clearTimeout(tQuoteTimer); tQuoteTimer = setTimeout(quoteBuy, 200); });
  $('t-presets').addEventListener('click', e => { const b = e.target.closest('[data-amt]'); if (!b) return; $('t-amt').value = b.dataset.amt; quoteBuy(); });
  $('t-shares').addEventListener('input', () => { clearTimeout(tQuoteTimer); tQuoteTimer = setTimeout(quoteSell, 200); });
  $('t-spresets').addEventListener('click', e => { const b = e.target.closest('[data-pct]'); if (!b || !tPos) return; const pct = Number(b.dataset.pct); $('t-shares').value = pct === 100 ? Math.round(tPos.shares) : Math.floor(tPos.shares * pct / 100); quoteSell(); });
  $('t-buy-go').addEventListener('click', doBuy);
  $('t-sell-go').addEventListener('click', doSell);
  window.addEventListener('resize', () => { if (view.name === 'auction' && !$('a-term').hidden) setSide(tSide, false); });
  // ---- launch page ----
  let imageData = null, lastLimits = null, lastEstimate = null;
  const pairInfo = { SOL: 'Native pair: the coin is quoted in SOL on pump.fun and in ETH on PONS. Contributions are SOL and ETH, and stay that way.', SPY: 'Stock pair: both coins are quoted in the tokenized S&P 500 ETF, SPYx on pump.fun and SPY on PONS. Contributions stay in SOL and ETH; the makers convert them at launch.', QQQ: 'Stock pair: both coins are quoted in the tokenized Nasdaq-100 ETF, QQQx on pump.fun and QQQ on PONS. Contributions stay in SOL and ETH; the makers convert them at launch.' };
  const pairQuote = { SOL: ['SOL', 'ETH'], SPY: ['SPYx', 'SPY'], QQQ: ['QQQx', 'QQQ'] };
  let pairTimer = null;
  function setPair(p, animate = true) {
    $('f-pair').value = p;
    document.querySelectorAll('#pair-seg .seg-btn').forEach(b => b.setAttribute('aria-checked', String(b.dataset.pair === p)));
    const btn = document.querySelector(`#pair-seg [data-pair="${p}"]`), ind = document.querySelector('#pair-seg .seg-ind');
    if (btn && ind && btn.offsetWidth) { ind.style.width = btn.offsetWidth + 'px'; ind.style.transform = `translateX(${btn.offsetLeft - 3}px)`; }
    const note = $('pair-note'); clearTimeout(pairTimer);
    if (animate && note.classList.contains('open')) { note.classList.remove('open'); pairTimer = setTimeout(() => { setText('pair-note-text', pairInfo[p]); note.classList.add('open'); }, 220); }
    else { setText('pair-note-text', pairInfo[p]); requestAnimationFrame(() => note.classList.add('open')); }
    updateTargetHint(); renderPreview();
  }
  function updateTargetHint() {
    if (!lastLimits?.minTargetUsd) return; const p = $('f-pair').value, mx = lastLimits.maxRaiseUsd?.[p];
    $('f-target').min = lastLimits.minTargetUsd; if (mx) $('f-target').max = mx;
    setText('f-target-hint', `Minimum ${fmtUsdFull(lastLimits.minTargetUsd)}${mx ? ', maximum about ' + fmtUsdFull(mx) + ' on this pair right now' : ''}: the raise must open both curves and pay every contributor 1:1 at launch.`);
  }
  document.querySelectorAll('#pair-seg .seg-btn').forEach(b => b.addEventListener('click', () => setPair(b.dataset.pair)));
  window.addEventListener('resize', () => { if (!$('launch-form').hidden) setPair($('f-pair').value, false); });
  // the preview: the auction card and the coin page as they will look, from the form as it is typed
  function renderPreview() {
    const panel = $('preview-panel'); if (!panel || panel.hidden) return;
    const name = $('f-name').value.trim() || 'Your coin', symbol = ($('f-symbol').value.trim() || 'TICKER').toUpperCase(), pair = $('f-pair').value, target = Number($('f-target').value) || 5000, hours = Number($('f-hours').value) || 48, desc = $('f-desc').value.trim();
    const a = { id: 'preview', name, symbol, image: imageData, pair, targetUsd: target, raisedUsd: 0, pct: 0, contributors: 0, status: 'open', deadline: new Date(Date.now() + hours * 3600000).toISOString(), createdAt: new Date().toISOString(), bySide: { sol: 0, rh: 0 } };
    $('preview-card').innerHTML = auctionCard(a, true).replace('href="/a/preview" data-nav', 'href="#" tabindex="-1" aria-hidden="true"');
    const keys = Object.keys(lastEstimate || {}).map(Number).sort((x, y) => x - y), near = keys.length ? keys.reduce((b, k) => Math.abs(k - target) < Math.abs(b - target) ? k : b, keys[0]) : null, est = near != null ? lastEstimate[near] : null;
    const cap = est?.openingFdv ? fmtUsd(est.openingFdv) : '—', [q1, q2] = pairQuote[pair] || pairQuote.SOL;
    const socials = [['X', $('f-twitter').value], ['Telegram', $('f-telegram').value], ['Website', $('f-website').value]].filter(x => x[1].trim()).map(x => x[0]).join(' · ');
    $('preview-coin').innerHTML = pvCoin({ name, symbol, image: imageData, desc, socials, q1, q2, cap });
  }
  // the coin-page preview block, shared by the auction form and the Launch-now form
  const pvCoin = ({ name, symbol, image, desc, socials, q1, q2, cap }) => `<div class="pv-head">${image ? `<img src="${image}" alt="">` : `<span class="mono">${esc(symbol[0])}</span>`}<div><b>${esc(name)}</b><i>$${esc(symbol)}${socials ? ' · ' + socials : ''}</i></div><div class="pv-gap"><span class="v">0.00%</span><span class="label">apart</span></div></div>
      <div class="pv-venues"><div><span class="chain"><span class="sw" style="background:var(--sol);width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:6px"></span>pump.fun · ${q1}</span><span class="label">opens at</span><span class="v">${cap}</span></div><div><span class="chain"><span class="sw" style="background:var(--rh);width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:6px"></span>PONS · ${q2}</span><span class="label">opens at</span><span class="v">${cap}</span></div></div>
      <div class="pv-desc">${esc(desc)}</div>`;
  ['f-name', 'f-symbol', 'f-desc', 'f-target', 'f-hours', 'f-twitter', 'f-telegram', 'f-website'].forEach(id => $(id).addEventListener('input', renderPreview));
  // sorting for the lists (remembered per browser)
  const sortOf = { open: 'newest', recent: 'newest' }; try { Object.assign(sortOf, JSON.parse(localStorage.getItem('twine.sort') || '{}')); } catch {}
  let lastAuctions = null, lastPaid = null, hideV1 = true;   // hideV1: the API's SITE_HIDE_V1 (on both /api/auctions and /api/paid); the Launches view and the home strip list Twine v2 launches then, the v1 auction lists only while it is off
  const V2_SORTS = ['newest', 'oldest', 'cap'];   // the sort keys that mean something for a v2 launch (raised / closest to fill are v1 raise figures)
  const COPY = {   // the user-facing copy per mode: v2 launches (default) or the retired v1 auctions (SITE_HIDE_V1=0)
    v2: { nav: 'Launches', title: 'Launches', lede: $('list-lede').textContent, next: $('home-next-lede').textContent, cta: 'All launches', paused: $('home-paused').textContent },
    v1: { nav: 'Auctions', title: 'Auctions', lede: 'Each auction raises SOL and Robinhood ETH for one coin. Every dollar contributed buys tokens at the opening price, one to one, inside the launch transaction itself. What the raise does not spend on the launch funds the coin\'s own market maker.', next: 'Buy into the next coin before it exists. When the auction fills, it launches on both chains in the same second.', cta: 'All auctions', paused: 'Auctions and launches are paused. Existing auctions are not accepting contributions until they resume.' } };
  function applyMode(on) {
    if (on === hideV1 && applyMode.done) return; hideV1 = on; applyMode.done = true; const c = COPY[on ? 'v2' : 'v1'];
    setText('nav-launches', c.nav); setText('list-title', c.title); setText('list-lede', c.lede); setText('home-next-lede', c.next); setText('home-next-cta', c.cta); setText('home-paused', c.paused);
    document.querySelectorAll('.ranges.sort [data-v1]').forEach(b => { b.hidden = on; });
    if (view.name === 'auctions') document.title = c.title + ' · Twine';
  }
  const sorters = {
    newest: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt), oldest: (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    raised: (a, b) => (b.raisedUsd || 0) - (a.raisedUsd || 0) || Date.parse(b.createdAt) - Date.parse(a.createdAt),
    closest: (a, b) => (b.pct || 0) - (a.pct || 0) || (b.raisedUsd || 0) - (a.raisedUsd || 0),
    cap: (a, b) => (coinCaps.get(b.id) || 0) - (coinCaps.get(a.id) || 0) || Date.parse(b.createdAt) - Date.parse(a.createdAt),
  };
  const sorted = (list, key) => [...list].sort(sorters[key] || sorters.newest);
  let listTab = 'open'; try { listTab = localStorage.getItem('twine.tab') === 'recent' ? 'recent' : 'open'; } catch {}
  function setListTab(t, animate = true) {
    listTab = t; try { localStorage.setItem('twine.tab', t); } catch {}
    for (const [id, key] of [['list-open', 'open'], ['auction-recent-wrap', 'recent']]) { const el = $(id), show = key === t; if (show && el.hidden && animate) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); } el.hidden = !show; }
    const bar = $('auction-tabs'); if (!bar) return; bar.querySelectorAll('.seg-btn').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    const btn = bar.querySelector('[data-tab="' + t + '"]'), ind = bar.querySelector('.seg-ind'); if (btn && ind && btn.offsetWidth) { ind.style.width = btn.offsetWidth + 'px'; ind.style.transform = 'translateX(' + (btn.offsetLeft - 3) + 'px)'; }
  }
  document.addEventListener('click', e => { const b = e.target.closest('#auction-tabs .seg-btn'); if (b && b.dataset.tab !== listTab) setListTab(b.dataset.tab); });
  window.addEventListener('resize', () => { if (view.name === 'auctions') setListTab(listTab, false); });
  const sortKey = list => hideV1 && !V2_SORTS.includes(sortOf[list]) ? 'newest' : sortOf[list];   // a remembered v1 sort (raised, closest) falls back to newest for v2 launches
  function renderLists() {
    if (hideV1) {   // Twine v2 launches: open (awaiting deposit / approval / queued / approved / launching) and launched & closed (live / retired / rejected / expired / abandoned / launch_failed)
      if (!lastPaid) return; const open = lastPaid.open || [], closed = lastPaid.closed || [];
      setText('cnt-open', String(open.length)); setText('cnt-recent', String(closed.length)); setListTab(listTab, false);
      const paidN = open.filter(a => a.status !== 'pending_payment').length, live = closed.filter(a => ['live', 'retiring'].includes(a.status)).length;
      setText('note-open', open.length ? open.length + ' launch' + (open.length === 1 ? '' : 'es') + ' on the way · ' + paidN + ' deposit' + (paidN === 1 ? '' : 's') + ' paid' : ''); setText('note-recent', closed.length ? live + ' live · ' + (closed.length - live) + ' closed' : '');
      const so = sorted(open, sortKey('open')); $('auction-open').innerHTML = open.length ? so.map((a, i) => paidCard(a, i === 0)).join('') : '<div class="empty">No launch is on the way right now.</div>';
      $('auction-recent').innerHTML = closed.length ? sorted(closed, sortKey('recent')).map(a => paidCard(a)).join('') : '<div class="empty">Nothing yet.</div>';
    } else {
      if (!lastAuctions) return; const open = lastAuctions.open || [], recent = lastAuctions.recent || [];
      setText('cnt-open', String(open.length)); setText('cnt-recent', String(recent.length)); setListTab(listTab, false);
      setText('note-open', open.length ? open.length + ' auction' + (open.length === 1 ? '' : 's') + ' taking contributions' : ''); setText('note-recent', recent.length ? recent.filter(a => a.status === 'live').length + ' launched · ' + recent.filter(a => a.status !== 'live').length + ' closed' : '');
      $('auction-open').innerHTML = open.length ? sorted(open, sortOf.open).map(a => auctionCard(a, a === open[0])).join('') : '<div class="empty">No auction is open right now.</div>';
      $('auction-recent').innerHTML = recent.length ? sorted(recent, sortOf.recent).map(a => auctionCard(a)).join('') : '<div class="empty">Nothing yet.</div>';
    }
    document.querySelectorAll('.ranges.sort').forEach(g => g.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sort === sortKey(g.dataset.list)))));
  }
  document.addEventListener('click', e => { const b = e.target.closest('.ranges.sort button'); if (!b) return; sortOf[b.closest('.ranges').dataset.list] = b.dataset.sort; try { localStorage.setItem('twine.sort', JSON.stringify(sortOf)); } catch {} renderLists(); });
  $('f-image').addEventListener('change', () => { const f = $('f-image').files[0]; if (!f) return; if (f.size > 1_500_000) { $('f-error').hidden = false; $('f-error').textContent = 'Image is larger than 1.5 MB.'; return; } const r = new FileReader(); r.onload = () => { imageData = r.result; $('f-preview').src = imageData; $('f-preview').hidden = false; setText('f-image-text', f.name); renderPreview(); }; r.readAsDataURL(f); });
  $('launch-form').addEventListener('submit', async e => {
    e.preventDefault(); const err = $('f-error'); err.hidden = true;
    if (!imageData) { err.hidden = false; err.textContent = 'Add an image first.'; return; }
    const body = { name: $('f-name').value, symbol: $('f-symbol').value, description: $('f-desc').value, targetUsd: Number($('f-target').value), hours: Number($('f-hours').value), pair: $('f-pair') ? $('f-pair').value : 'SOL', twitter: $('f-twitter').value, telegram: $('f-telegram').value, website: $('f-website').value, imageData };
    $('f-submit').disabled = true;
    try { const r = await fetch('/api/auctions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw Error(r.status === 413 ? 'The image is too large for the server. Use one under 1.5 MB.' : 'The server is busy or restarting. Try again in a few seconds.'); } if (!r.ok) throw Error(j.error || r.status); history.pushState(null, '', '/a/' + j.id); route(); }
    catch (ex) { err.hidden = false; err.textContent = ex.message; } finally { $('f-submit').disabled = false; }
  });
  function renderAuctions(j) {
    if (j.hideV1 != null) applyMode(Boolean(j.hideV1));
    publicCreate = Boolean(j.publicCreate) && !j.paused; $('home-paused').hidden = !j.paused;
    lastLimits = j.limits || lastLimits; lastEstimate = j.estimate || lastEstimate; updateTargetHint();
    { const C = j.limits?.curve; $('f-curve-note').hidden = !C; if (C) setText('f-curve-note', `Tradeable raise: deposits buy shares on a curve whose price rises ${C.ratio}× from the floor to the target, so early money ends up with more tokens per dollar. Shares can be sold back any time before the fill; ${C.feeBps / 100}% fee per trade goes to the coin's market maker; one wallet may hold at most ${C.walletCapPct}% of the supply.`); }
    const open = j.open || [], recent = j.recent || []; lastAuctions = j;
    renderLaunchMode();   // which launch form shows (Launch now / auction / "v2 soon"), the badge, the strip, the CTA
    if (!hideV1) {   // the v1 lists (SITE_HIDE_V1 off); with it on the home strip and the tabs come from /api/paid (renderPaidList)
      $('home-auctions').hidden = false;
      $('home-auction-cards').innerHTML = open.length ? open.map((a, i) => auctionCard(a, i === 0)).join('') : '<div class="empty">No auction is open right now.</div>';
      const lf = $('launch-featured'); if (lf) lf.innerHTML = open.slice(0, 1).map(a => auctionCard(a, true)).join('');
    } else if (j.paused && !(lastPaid?.open || []).length) $('home-auctions').hidden = false;   // nothing on the way, but the pause notice still shows
    renderLists();
    if (j.estimate) $('est-table').querySelector('tbody').innerHTML = Object.entries(j.estimate).map(([u, e]) => `<tr><td class="num">${fmtUsdFull(+u)}</td><td class="r num">${e ? fmtUsd(e.openingFdv) : 'out of range'}</td><td class="r num">${e ? e.tokensPerUsd.toLocaleString() : '—'}</td><td class="r num">${e ? fmtUsdFull(e.makerInventoryUsd) : '—'}</td><td class="r num">${e ? fmtUsdFull(e.cashUsd) : '—'}</td></tr>`).join('');
  }
  function renderFlywheel(f) {
    const n = f.burned?.total || 0, coins = `${f.armed} coin${f.armed === 1 ? '' : 's'} feeding it`;
    setText('fw-stat', n ? `${Math.round(n).toLocaleString('en-US')} TWINE burned · from ${f.spent.sol.toFixed(3)} SOL + ${f.spent.eth.toFixed(4)} ETH of fees · ${coins}` : `${coins} · no burns yet`);
    const B = f.burns || []; $('fw-burns-wrap').hidden = !B.length;
    $('fw-burns').innerHTML = B.map(b => `<tr><td>${new Date(b.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>$${esc(b.coin)}</td><td><span class="dot" style="background:var(--${b.side === 'sol' ? 'sol' : 'rh'})"></span>${b.side === 'sol' ? 'pump.fun' : 'PONS'}</td><td class="r num">${b.spent != null ? b.spent.toFixed(b.side === 'sol' ? 4 : 5) + (b.side === 'sol' ? ' SOL' : ' ETH') : '—'}</td><td class="r num">${Math.round(b.tokens || 0).toLocaleString('en-US')}</td><td>${b.burnTx ? `<a href="${b.side === 'sol' ? 'https://solscan.io/tx/' : 'https://rh-scan.com/tx/'}${esc(b.burnTx)}" target="_blank" rel="noopener">burn</a>` : ''}</td></tr>`).join('');
  }
  function renderCoins(j) { const coins = (j.coins || []); noteCoins(coins); $('home-coins').hidden = coins.length < 2; $('home-coin-cards').innerHTML = coins.map(coinCard).join(''); }

  // ---- Launch now (paid launches, PAID-LAUNCH.md §6): the cards, the launch-page mode + quote, the /a/<id> status page, the fee-mode numbers ----
  const paidStateText = a => ({ pending_payment: 'Awaiting deposit', awaiting_approval: 'Awaiting approval', queued: 'Queued', approved: 'Approved · launching', launching: 'Launching', live: 'Live', launch_failed: 'Launch hiccup · retrying', rejected: 'Rejected · refunded', expired: 'Expired · refunded', abandoned: 'Not paid · lapsed', retiring: 'Retiring', retired: 'Retired' }[a.status] ?? a.status);
  const fmtSol = (n, d = 3) => n == null || !isFinite(n) ? '—' : Number(n).toFixed(d) + ' SOL', fmtEth = (n, d = 4) => n == null || !isFinite(n) ? '—' : Number(n).toFixed(d) + ' ETH';
  const usdOf = (sol, eth, fx) => fx ? (sol || 0) * fx.SOL + (eth || 0) * fx.ETH : null;
  const WAITING = ['awaiting_approval', 'queued', 'approved', 'launching', 'launch_failed'];
  // the card: status pill, the two market caps (the opening cap until it is live), the deposit and what it opens at, a link to the launch page (/a/<id>) — or to the
  // coin's mirror (/c/<id>) once it is live: the chart is what a live coin's visitor wants, and the launch page is one link away from there
  const paidCard = (a, featured = false) => { const sd = coinSides.get(a.id), open = a.launch?.openingFdv ?? a.quote?.openingFdv, live = a.status === 'live', dep = fmtSol(a.payment?.receivedSol || a.payment?.requiredSol, 2), opens = 'opens at ≈ ' + fmtUsd(open);
    const meta = live ? (a.reserve?.reserveMet ? 'reserve met · dev earns ' + ((a.devShareBps ?? 5000) / 100) + '% of fees' : 'building its reserve from fees')
      : a.status === 'pending_payment' ? 'deposit ' + dep + ' · ' + opens : a.status === 'launch_failed' ? 'launch hiccup · deposit ' + dep + ' safe' : WAITING.includes(a.status) ? 'deposit ' + dep + ' paid · ' + opens
      : a.status === 'retiring' ? 'inventory going back into the curves' : a.status === 'retired' ? 'inventory unwound · pool repaid' : ['rejected', 'expired'].includes(a.status) ? 'deposit ' + dep + ' refunded' : a.status === 'abandoned' ? 'deposit never paid' : '';
    return `<a class="card${live || featured ? ' featured' : ''}" href="${live && a.coinId ? '/c/' + a.coinId : '/a/' + a.id}" data-nav>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">${ident(a)}<span class="state ${a.status}">${paidStateText(a)}</span></div>
      <div class="pair"><div><span class="label" style="--sw:var(--sol)">pump.fun</span><span class="n">${live && sd ? fmtUsd(sd.pump) : open ? fmtUsd(open) : '—'}</span></div><div><span class="label" style="--sw:var(--rh)">PONS</span><span class="n">${live && sd ? fmtUsd(sd.pons) : open ? fmtUsd(open) : '—'}</span></div></div>
      <div class="meta"><span>${meta}</span><span>${a.launch?.launchedAt ? 'launched ' + ago(a.launch.launchedAt) : a.payment?.paidAt ? 'paid ' + ago(a.payment.paidAt) : ago(a.createdAt)}</span></div></a>`; };
  function renderPaidList(p) {
    if (p.hideV1 != null) applyMode(Boolean(p.hideV1));
    paidEnabled = Boolean(p.enabled); lastPaid = p; const all = [...(p.queue || []), ...(p.recent || [])];
    if (hideV1) {   // Twine v2 is the product: the home strip "The next twin" is the open list (hidden when empty, unless the pause notice has to show), the tabs come from renderLists(); the separate v2 strips are redundant
      const open = p.open || []; $('home-auctions').hidden = !(open.length || !$('home-paused').hidden);
      const nOpen = p.openCount ?? open.length; $('home-auctions').hidden = !(open.length || nOpen || !$('home-paused').hidden); $('home-auction-cards').innerHTML = open.length ? open.map((a, i) => paidCard(a, i === 0)).join('') : nOpen ? `<div class="empty">${nOpen} launch${nOpen === 1 ? ' is' : 'es are'} waiting for the operator. Names and tickers appear the second a coin goes live on both chains, not before.</div>` : '<div class="empty">No launch is on the way right now.</div>';
      $('home-paid').hidden = true; $('list-paid').hidden = true; renderLists();
    } else for (const [strip, cards, note] of [['home-paid', 'home-paid-cards', null], ['list-paid', 'list-paid-cards', 'note-paid']]) { const el = $(strip); if (!el) continue; el.hidden = !paidEnabled || !all.length; if (el.hidden) continue; $(cards).innerHTML = all.map(a => paidCard(a)).join(''); if (note) setText(note, `${p.queueCount ?? (p.queue || []).length} waiting · ${(p.recent || []).filter(a => a.status === 'live').length} live · ${(p.recent || []).filter(a => a.status !== 'live').length} closed`); }
    renderLaunchMode();
  }
  // the live quote on the launch page: deposit, what the pool fronts, the opening cap, the seed split, the gate
  function renderQuote(q) {
    paidInfo = q; paidEnabled = Boolean(q.enabled); if (q.fx) lastFx = q.fx; if (q.publicCreate != null) publicCreate = Boolean(q.publicCreate) && !q.paused;   // the quote is the authority on both flags (it is polled on every view; /api/auctions only on some)
    const g = q.gates, grid = $('paid-quote-grid'), fx = q.fx;
    if (q.openingFdv) {
      // the deposit is the API's figure (DEPOSIT_MIN_SOL and the margin live in sizing.mjs, never here); the seed shows the PONS % actually used
      const pumpPct = q.pumpSeedPct ?? q.supplyPct?.pump, ponsPct = q.ponsSeedPct ?? q.supplyPct?.pons;
      grid.innerHTML = `<div><span class="label">your deposit · refundable</span><span class="n">${fmtSol(q.depositSol, 2)}<small>≈ ${fmtUsdFull(q.depositUsd ?? (fx ? q.depositSol * fx.SOL : null))} · set by the API at today's prices</small></span></div>
        <div><span class="label">the pool fronts</span><span class="n">${fmtSol(q.frontSol, 2)} + ${fmtEth(q.frontEth, 4)}<small>≈ ${fmtUsdFull(q.frontUsd ?? usdOf(q.frontSol, q.frontEth, fx))}</small></span></div>
        <div><span class="label">opening market cap</span><span class="n">${fmtUsdFull(q.openingFdv)}<small>on both chains</small></span></div>
        <div><span class="label">the seed · maker inventory</span><span class="n">${pumpPct ?? '—'}%<small>of supply on pump.fun${q.pumpTokens ? ' · ' + fmtTok(q.pumpTokens) : ''}</small></span><span class="n">${ponsPct ?? '—'}%<small>PONS seed used${q.ponsTokens ? ' · ' + fmtTok(q.ponsTokens) : ''}</small></span></div>`;
      setText('paid-quote-at', fx ? `SOL ${fmtUsdFull(fx.SOL)} · ETH ${fmtUsdFull(fx.ETH)}` : '');
    } else { grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${esc(q.error || 'Reading prices…')}</div>`; setText('paid-quote-at', ''); }
    setText('paid-quote-note', `Prices refresh every few seconds; the deposit is fixed when you submit and re-quoted at approval. 2% creator fee on each chain. One launch per paying wallet every ${q.cooldownH ?? 24} h; undecided after ${q.approvalTtlH ?? 48} h → deposit refunded; unpaid after ${q.paymentTtlH ?? 24} h → the request lapses.`);
    const gate = $('paid-gate');
    if (g) { const n = g.queue ?? 0; gate.className = 'gate ' + (g.open ? 'open' : 'closed'); gate.textContent = g.open ? `launches open · ${n} in queue` : `launches closed, ${n} in queue`;
      setText('paid-gate-note', g.open ? (g.machines ? `${g.machines.live} of ${g.machines.max} maker slots in use.` : '') : (g.closed ? 'The operator has closed new launches for now. ' : g.machines && !g.machines.open ? `All ${g.machines.max} maker slots are in use. ` : g.money?.error ? 'The pool is not reachable right now. ' : 'The pool cannot front the next launch right now. ') + 'You can still submit and pay: your launch joins a first-come queue and goes out when a slot frees up.'); }
    else { gate.className = 'gate'; gate.textContent = 'checking the gates…'; setText('paid-gate-note', ''); }
    $('pf-submit').disabled = !paidEnabled || Boolean(q.paused); setText('pf-submit-note', q.paused ? 'Launches are paused right now.' : 'You pay the deposit on the next screen; nothing is sent from here.');
    renderLaunchMode();
  }
  // the launch page's mode: Launch now when paid is enabled (auction creation hidden then), the auction form when it is public and paid is off, else the "v2 soon" panel
  function renderLaunchMode() {
    const auctionOn = publicCreate && !paidEnabled, modes = [paidEnabled && 'paid', auctionOn && 'auction'].filter(Boolean);
    if (!modes.includes(launchMode)) launchMode = modes[0] ?? 'auction';
    const seg = $('mode-seg'); seg.hidden = modes.length < 2;
    seg.querySelectorAll('.seg-btn').forEach(b => { b.hidden = !modes.includes(b.dataset.mode); b.setAttribute('aria-checked', String(b.dataset.mode === launchMode)); });
    if (!seg.hidden) { const btn = seg.querySelector(`[data-mode="${launchMode}"]`), ind = seg.querySelector('.seg-ind'); if (btn && ind && btn.offsetWidth) { ind.style.width = btn.offsetWidth + 'px'; ind.style.transform = `translateX(${btn.offsetLeft - 3}px)`; } }
    const paidShown = launchMode === 'paid' && paidEnabled; $('launch-paid').hidden = !paidShown; $('launch-auction').hidden = paidShown;
    $('launch-form').hidden = !auctionOn; $('launch-soon').hidden = auctionOn || paidEnabled;
    $('launch-badge').hidden = publicCreate || paidEnabled; $('v2-strip').hidden = publicCreate || paidEnabled;
    const cta = $('auctions-cta'); if (cta) { cta.textContent = publicCreate || paidEnabled ? 'Launch a token' : 'Twine v2 · soon'; cta.hidden = !(publicCreate || paidEnabled); }
    const wasHidden = $('preview-panel').hidden; $('preview-panel').hidden = !auctionOn; if (auctionOn && (wasHidden || !$('pair-note').classList.contains('open'))) requestAnimationFrame(() => setPair($('f-pair').value, false)); else if (auctionOn) renderPreview();
    if (paidShown) { renderPaidPreview(); prefillDevWallet(); }
  }
  // the declared dev wallet field: the terminal's connected Solana wallet (W, a real Phantom/Solflare key, never the demo one) when there is one, the demo dev
  // wallet in demo mode; never overwrites what the visitor typed. "Use Phantom" asks the wallet for its key the same way the terminal connects.
  const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  function prefillDevWallet() { const f = $('pf-dev'); if (!f || f.value.trim()) return; if (W?.chain === 'sol' && !W.demo && W.address) f.value = W.address; else if (paidInfo?.demo) f.value = demoDev(); }
  $('pf-dev-connect').addEventListener('click', async () => {
    const err = $('pf-error'); err.hidden = true;
    try { const p = window.phantom?.solana ?? window.solana; if (!p?.connect) throw Error('No Solana wallet found. Install Phantom (phantom.app) or Solflare, or paste the address of the wallet you will pay from.'); const r = await p.connect(); $('pf-dev').value = r.publicKey.toString(); }
    catch (e) { err.hidden = false; err.textContent = e?.message || String(e); }
  });
  function renderPaidPreview() {
    const el = $('paid-preview-coin'); if (!el || $('launch-paid').hidden) return;
    const name = $('pf-name').value.trim() || 'Your coin', symbol = ($('pf-symbol').value.trim() || 'TICKER').toUpperCase(), desc = $('pf-desc').value.trim(), cap = paidInfo?.openingFdv ? fmtUsd(paidInfo.openingFdv) : '—';
    const socials = [['X', $('pf-twitter').value], ['Telegram', $('pf-telegram').value], ['Website', $('pf-website').value]].filter(x => x[1].trim()).map(x => x[0]).join(' · ');
    el.innerHTML = pvCoin({ name, symbol, image: paidImage, desc, socials, q1: 'SOL', q2: 'ETH', cap });
  }
  $('mode-seg').addEventListener('click', e => { const b = e.target.closest('.seg-btn'); if (b && b.dataset.mode !== launchMode) { launchMode = b.dataset.mode; renderLaunchMode(); } });
  window.addEventListener('resize', () => { if (view.name === 'launch' && !$('mode-seg').hidden) renderLaunchMode(); });
  $('pf-image').addEventListener('change', () => { const f = $('pf-image').files[0]; if (!f) return; if (f.size > 1_500_000) { $('pf-error').hidden = false; $('pf-error').textContent = 'Image is larger than 1.5 MB.'; return; } const r = new FileReader(); r.onload = () => { paidImage = r.result; $('pf-preview').src = paidImage; $('pf-preview').hidden = false; setText('pf-image-text', f.name); renderPaidPreview(); }; r.readAsDataURL(f); });
  ['pf-name', 'pf-symbol', 'pf-desc', 'pf-twitter', 'pf-telegram', 'pf-website'].forEach(id => $(id).addEventListener('input', renderPaidPreview));
  $('paid-form').addEventListener('submit', async e => {
    e.preventDefault(); const err = $('pf-error'); err.hidden = true;
    if (!paidImage) { err.hidden = false; err.textContent = 'Add an image first: the launch cannot run without one.'; return; }
    const devWallet = $('pf-dev').value.trim(); if (!B58.test(devWallet)) { err.hidden = false; err.textContent = 'Enter the Solana wallet you will pay the deposit from (a base58 address): it receives the dev share and every refund.'; $('pf-dev').focus(); return; }   // the API validates the key for real (32 bytes); this only saves a round trip
    const body = { name: $('pf-name').value, symbol: $('pf-symbol').value, description: $('pf-desc').value, twitter: $('pf-twitter').value, telegram: $('pf-telegram').value, website: $('pf-website').value, imageData: paidImage, pair: 'SOL', devWallet };
    $('pf-submit').disabled = true;
    try { const r = await fetch('/api/paid', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw Error(r.status === 413 ? 'The image is too large for the server. Use one under 1.5 MB.' : 'The server is busy or restarting. Try again in a few seconds.'); } if (!r.ok) throw Error(j.error || r.status); paidPage = j; history.pushState(null, '', '/a/' + j.id); route(); }
    catch (ex) { err.hidden = false; err.textContent = ex.message; } finally { $('pf-submit').disabled = false; }
  });
  // ---- the status page (/a/<id> for a paid record) ----
  // viewPaid's reserve carries { targetUsd: { sol, rh }, cashUsd: { sol, rh } }; the coin state's paid block is per side. One shape for the renderer:
  const paidNorm = a => ({ status: a.status, reserve: { sol: { cashUsd: a.reserve?.cashUsd?.sol ?? null, targetUsd: a.reserve?.targetUsd?.sol ?? null }, rh: { cashUsd: a.reserve?.cashUsd?.rh ?? null, targetUsd: a.reserve?.targetUsd?.rh ?? null }, reserveMet: Boolean(a.reserve?.reserveMet), reserveMetAt: a.reserve?.reserveMetAt ?? null },
    front: { sol: a.front?.sol ?? 0, eth: a.front?.eth ?? 0, repaidSol: a.front?.repaidSol ?? 0, writtenOffSol: a.front?.writtenOffSol ?? 0 }, refund: { sol: a.waterfall?.deposit?.sol || a.payment?.receivedSol || 0, paidSol: a.refund?.paidSol ?? 0 },
    devPaid: a.waterfall?.devPaid ?? { sol: 0, eth: 0 }, devPending: a.waterfall?.devPending ?? { sol: 0, eth: 0 }, devShareBps: a.devShareBps ?? 0, devShareBpsFunded: a.devShareBpsFunded ?? 5000, burned: a.waterfall?.burned ?? { sol: 0, eth: 0 }, funded: Boolean(a.reserve?.funded), fundedAt: a.reserve?.fundedAt ?? null, lastClaimAt: a.waterfall?.lastClaimAt ?? null, waterfall: Boolean(a.waterfall), at: a.waterfall?.at ?? null });
  // the fee-mode numbers (status page and coin page): reserve vs target per side, dev share and earnings, front repaid, deposit refunded, funded
  function renderFeeNumbers(p, gridId, progId, fx) {
    const pct = (a, b) => b > 0 ? Math.max(0, Math.min(100, a / b * 100)) : 0, r = p.reserve;
    const side = (k, label) => { const s = r[k], met = s.cashUsd != null && s.targetUsd != null && s.cashUsd >= s.targetUsd; return `<div><span class="label">${label} reserve</span><span class="n ${met ? 'ok' : s.cashUsd == null ? 'dim' : ''}">${s.cashUsd == null ? '—' : fmtUsdFull(s.cashUsd)}<small>of ${s.targetUsd == null ? '—' : fmtUsdFull(s.targetUsd)} target</small></span></div>`; };
    const devUsd = usdOf(p.devPaid.sol, p.devPaid.eth, fx), pendingUsd = usdOf(p.devPending.sol, p.devPending.eth, fx);
    $(gridId).innerHTML = side('sol', 'pump.fun') + side('rh', 'PONS') +
      `<div><span class="label">dev share of every fee claim</span><span class="n ${r.reserveMet ? 'ok' : ''}">${(p.devShareBps / 100).toFixed(0)}%<small>${r.reserveMet ? 'reserve met' + (r.reserveMetAt ? ' ' + ago(r.reserveMetAt) : '') + ', for good' : 'until both reserves are met, then ' + (p.devShareBpsFunded / 100).toFixed(0) + '%'}</small></span></div>
       <div><span class="label">dev earnings paid</span><span class="n">${fmtSol(p.devPaid.sol, 4)}<small>+ ${fmtEth(p.devPaid.eth, 5)}${devUsd != null ? ' ≈ ' + fmtUsdFull(devUsd) : ''}${pendingUsd ? ' · ' + fmtUsdFull(pendingUsd) + ' pending' : ''}</small></span></div>`;
    const bar = (label, a, b, accent, extra) => `<div class="row"><span>${label}</span><b>${a.toFixed(3)} / ${b.toFixed(3)} SOL${extra ? ' · ' + extra : ''}</b></div><div class="bar" style="--accent:${accent}"><i style="width:${pct(a, b)}%"></i></div>`;
    $(progId).innerHTML = bar('front repaid to the pool', p.front.repaidSol, p.front.sol, 'var(--sol)', p.front.writtenOffSol ? p.front.writtenOffSol.toFixed(3) + ' written off' : '') + bar('deposit refunded to the dev', p.refund.paidSol, p.refund.sol, 'var(--ok)', '') +
      `<div class="row"><span>${p.funded ? 'funded: pool repaid and deposit refunded; the maker\'s half above its reserve now buys and burns TWINE' + (p.fundedAt ? ' · since ' + ago(p.fundedAt) : '') : 'once the pool is repaid and the deposit refunded, the maker\'s half above its reserve buys and burns TWINE'}</span><b>${p.burned.sol ? p.burned.sol.toFixed(4) + ' SOL burned' : ''}</b></div>` +
      (p.waterfall ? '' : '<div class="row"><span style="color:var(--dim)">the treasury has not written its first pass yet; these are the launch record\'s numbers</span></div>');
  }
  function paidTimeline(a) {
    const s = a.status, paid = Boolean(a.payment?.paidAt), approved = a.approval?.status === 'approved', launched = Boolean(a.launch?.launchedAt), live = ['live', 'retiring', 'retired'].includes(s), bad = ['rejected', 'expired', 'abandoned'].includes(s), when = iso => iso ? timeLeft(iso).replace(' left', '') : '';
    const out = [{ cls: 'done', title: 'Launch requested', at: a.createdAt, text: `deposit of ${fmtSol(a.payment?.requiredSol, 2)} to the payment address` }];
    out.push(paid ? { cls: 'done', title: 'Deposit paid', at: a.payment.paidAt, text: `${fmtSol(a.payment.receivedSol, 4)} from ${short(a.devWallet)} — the dev wallet` } : s === 'abandoned' ? { cls: 'bad', title: 'Not paid in time', at: a.paymentDeadline, text: a.payment?.receivedSol > 0 ? 'a partial payment was refunded to its sender' : 'nothing was received before the deadline' } : { cls: 'now', title: 'Waiting for the deposit', text: (a.payment?.expectedFrom ? 'from ' + short(a.payment.expectedFrom) + (a.paymentDeadline ? ' · ' : '') : '') + (a.paymentDeadline ? when(a.paymentDeadline) + ' to pay' : '') });
    if (bad && s !== 'abandoned') out.push({ cls: 'bad', title: s === 'rejected' ? 'Rejected' : 'Not decided in time', at: a.approval?.at, text: (a.approval?.note === 'cooldown' ? 'this wallet already paid for another launch inside the cooldown window; ' : a.approval?.note ? esc(a.approval.note) + '; ' : '') + 'the deposit goes back to the paying wallet' });
    else if (s !== 'abandoned') out.push(approved ? { cls: 'done', title: 'Approved', at: a.approval.at, text: a.approval.note ? esc(a.approval.note) : '' } : paid ? { cls: 'now', title: s === 'queued' ? 'Queued' : a.approval?.status === 'held' ? 'On hold' : 'Awaiting approval', text: s === 'queued' ? 'launches are closed or every maker slot is in use; first come, first served when one frees up' : a.approval?.status === 'held' ? (a.approval.note ? esc(a.approval.note) : 'the operator is looking at it') : 'an operator checks every launch' + (a.approvalDeadline ? ' · refunded if undecided in ' + when(a.approvalDeadline) : '') } : { cls: 'off', title: 'Approval', text: 'an operator checks every launch' });
    if (!bad) {
      out.push(launched ? { cls: 'done', title: 'Launched on both chains', at: a.launch.launchedAt, text: `opened at ${fmtUsdFull(a.launch.openingFdv)} on pump.fun and PONS` } : approved ? { cls: s === 'launch_failed' ? 'bad' : 'now', title: s === 'launch_failed' ? 'Launch hiccup' : 'Launching', text: s === 'launch_failed' ? 'it retries automatically; the deposit is safe' : 'the pool fronts the seed; both coins go out in the same second' } : { cls: 'off', title: 'Launch', text: 'pump.fun and PONS in the same second, same opening cap' });
      out.push(live ? { cls: s === 'live' ? 'now' : 'done', title: 'Live · fee-powered mirror', text: a.reserve?.reserveMet ? 'reserve met: you get half of every fee claim, for good' : 'the maker keeps every fee until its reserve is met on both sides' } : { cls: 'off', title: 'Live', text: 'the maker builds its reserve from fees, then you get half of every claim' });
      if (s === 'retiring' || s === 'retired') out.push({ cls: s === 'retired' ? 'done' : 'now', title: s === 'retired' ? 'Retired' : 'Retiring', at: a.retire?.at ?? a.retire?.requestedAt, text: `${esc(a.retire?.reason || 'operator')}: the inventory went back into the curves, the pool was repaid with what came back` });
    }
    return out;
  }
  // the demo dev wallet (SITE_DEMO): a real 32-byte key (32 random bytes through the terminal's b58 encoder), since createPaid validates the declared wallet; one per browser, kept in localStorage
  const demoDev = () => { let w = null; try { w = localStorage.getItem('twine.demo.dev'); } catch {} if (!w || /^DemoDev/.test(w)) { w = b58(crypto.getRandomValues(new Uint8Array(32))); try { localStorage.setItem('twine.demo.dev', w); } catch {} } return w; };
  function renderPaid(a) {
    document.title = `$${a.symbol} launch · Twine`;
    $('p-head').innerHTML = ident(a, true).replace(/^<div class="ahead">|<\/div>$/g, '');
    const st = $('p-state'); st.className = 'state ' + a.status; st.textContent = paidStateText(a);
    setText('p-time', a.launch?.launchedAt ? 'launched ' + ago(a.launch.launchedAt) : a.payment?.paidAt ? 'paid ' + ago(a.payment.paidAt) : 'created ' + ago(a.createdAt));
    setText('p-desc', a.description || ''); $('p-desc').hidden = !a.description;
    $('p-links').innerHTML = [['X', a.twitter], ['Telegram', a.telegram], ['Website', a.website]].filter(x => x[1]).map(([l, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener" style="color:var(--muted);border-bottom:1px dotted var(--dim)">${l}</a>`).join('');
    $('p-about').hidden = !a.description && !(a.twitter || a.telegram || a.website);
    const q = a.quote || {}, fx = a.fx || lastFx; if (a.fx) lastFx = a.fx;
    $('p-quote').innerHTML = `<div><span class="label">deposit · refundable</span><span class="n">${fmtSol(a.payment?.requiredSol, 2)}<small>${fx && a.payment?.requiredSol ? '≈ ' + fmtUsdFull(a.payment.requiredSol * fx.SOL) : ''}</small></span></div>
      <div><span class="label">the pool fronts</span><span class="n">${fmtSol(a.front?.sol ?? q.frontSol, 2)} + ${fmtEth(a.front?.eth ?? q.frontEth, 4)}</span></div>
      <div><span class="label">opening market cap</span><span class="n">${fmtUsdFull(a.launch?.openingFdv ?? q.openingFdv)}<small>both chains</small></span></div>
      <div><span class="label">the seed · maker inventory</span><span class="n">${q.supplyPct?.pump ?? '—'}%<small>on pump.fun</small></span><span class="n">${q.supplyPct?.pons ?? '—'}%<small>on PONS</small></span></div>`;
    // the deposit: address, amount, Pay with Phantom (a wallet-built transfer), Simulate payment in demo
    const pending = a.status === 'pending_payment'; $('p-pay').hidden = !pending;
    if (pending) {
      const owed = Math.max(0, a.payment.requiredSol - a.payment.receivedSol);
      setText('p-pay-addr', a.payment.address || '—'); setText('p-pay-amt', fmtSol(owed, 4)); setText('p-pay-deadline', a.paymentDeadline ? 'pay within ' + timeLeft(a.paymentDeadline).replace(' left', '') : '');
      setText('p-pay-recv', a.payment.receivedSol > 0 ? `received ${fmtSol(a.payment.receivedSol, 4)} of ${fmtSol(a.payment.requiredSol, 4)} so far` : ''); setText('p-pay-cooldown', String(a.cooldownH ?? 24));
      // the declared wallet next to the address (a legacy record without one keeps "from a wallet you control": its first payer is the dev)
      const from = a.payment.expectedFrom; $('p-pay-from').innerHTML = from ? `from <b class="num" title="${esc(from)}">${short(from)}</b> <span style="color:var(--dim)">· payments from any other wallet are refunded</span>` : 'from a wallet you control.';
      setText('p-pay-note', from ? `The wallet you declared (${short(from)}) is the dev wallet: it receives the fee share, the deposit refund, and the whole deposit back if the launch is rejected or not decided in time. Pay from it: a payment from any other wallet is refunded to its sender (minus the network fee) and never counts. Exchange withdrawals cannot be credited. One launch per paying wallet every ${a.cooldownH ?? 24} h; a second deposit from the same wallet inside that window is refunded automatically.`
        : `The wallet that pays becomes the dev wallet: it receives the fee share, the deposit refund, and the whole deposit back if the launch is rejected or not decided in time. Exchange withdrawals cannot be credited. One launch per paying wallet every ${a.cooldownH ?? 24} h; a second deposit from the same wallet inside that window is refunded automatically.`);
      $('p-pay-demo').hidden = !a.demo; $('p-pay-demo-note').hidden = !a.demo; if (a.demo) setText('p-pay-demo-note', `Demo mode: "Simulate payment" credits a made-up transfer from ${from ? 'the declared wallet ' + short(from) : 'the demo wallet ' + short(demoDev())} (nothing is sent). A second launch paid from the same wallet inside ${a.cooldownH ?? 24} h is rejected and refunded automatically: that is the cooldown.`);
    }
    $('p-timeline').innerHTML = paidTimeline(a).map(s => `<li class="${s.cls}"><span class="m"></span><div><b>${s.title}${s.at ? `<span class="t">${new Date(s.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>` : ''}</b>${s.text ? `<span>${s.text}</span>` : ''}</div></li>`).join('');
    setText('p-status-note', a.paused && WAITING.includes(a.status) ? 'launches are paused; the queue resumes with them' : a.demo ? 'demo' : '');
    // the fee-mode numbers once the coin exists
    const feeOn = ['live', 'retiring', 'retired'].includes(a.status); $('p-fee').hidden = !feeOn;
    if (feeOn) { const p = paidNorm(a); renderFeeNumbers(p, 'p-fee-grid', 'p-fee-prog', fx); const vc = $('p-view-coin'); vc.hidden = !a.coinId || a.status !== 'live'; if (a.coinId) vc.setAttribute('href', '/c/' + a.coinId);
      setText('p-fee-lede', a.status === 'live' ? 'Seeded with inventory by the Twine pool, no cash; its creator fees build a reserve on each side, then flow down the waterfall.' : 'The coin was retired; these are the waterfall\'s last numbers.');
      setText('p-fee-note', p.lastClaimAt ? 'last fee claim ' + ago(p.lastClaimAt) + (p.at ? ' · treasury pass ' + ago(p.at) : '') : (p.waterfall ? '' : 'The treasury writes its first pass within a minute of the launch.')); }
    const L = a.launch; $('p-launch').hidden = !(L && (L.pumpMint || L.steps?.length));
    if (L) {
      setText('p-ca-pump', L.pumpMint ?? 'pending'); setText('p-ca-pons', L.ponsToken ?? L.ponsCurve ?? 'pending');
      const names = { preflight: 'Preflight: the exact launch simulated, nothing sent', preflight_failed: 'Preflight failed, nothing sent', fronting: 'The pool fronted the seed and the gas', fronting_recorded: 'Pool front recorded (rehearsal)', deposit_to_pool: 'Deposit moved to the pool', funded: 'Maker wallets funded', funded_recorded: 'Maker funding recorded (demo)', engine_armed: 'Market maker armed', engine_armed_demo: 'Market maker armed (demo)', engine_armed_dry: 'Market maker armed (dry run)', launched: 'Launched on both chains', live: 'Live on Twine', dry_run_complete: 'Dry run complete', preflight_only: 'Preflight only' };
      $('p-steps').innerHTML = (L.steps || []).map(s => `<li><span class="t">${new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span class="${/failed|error/.test(s.name) ? '' : 'done'}">${names[s.name] ?? esc(s.name.replace(/_/g, ' '))}${s.error ? ': ' + esc(s.error) : ''}</span></li>`).join('');
      setText('p-launch-note', L.launchedAt ? 'launched ' + ago(L.launchedAt) : a.attempts ? `attempt ${a.attempts + 1}` : '');
    }
    const R = a.refund || { sol: 0, paidSol: 0, txs: [] }, refunding = ['rejected', 'expired', 'abandoned'].includes(a.status) || (R.txs?.length && !feeOn); $('p-refund').hidden = !refunding;
    if (refunding) { const owed = R.sol || a.payment?.receivedSol || 0; setText('p-refund-text', owed > 0 ? `${fmtSol(R.paidSol, 4)} of ${fmtSol(owed, 4)} refunded to ${short(a.devWallet || a.payment?.txs?.[0]?.from)}${R.paidSol + 1e-9 < owed ? (R.txs?.some(t => t.pending) ? ' · confirming' : ' · the rest follows automatically') : ''}.` : 'Nothing to refund: no payment was received.');
      $('p-refund-txs').innerHTML = (R.txs || []).map(t => `<div>${esc(t.kind || 'refund')} · ${fmtSol(t.sol, 4)} → ${short(t.to)}${t.tx ? ' · ' + (/^demo-/.test(t.tx) ? esc(t.tx) : `<a href="https://solscan.io/tx/${esc(t.tx)}" target="_blank" rel="noopener">${short(t.tx)}</a>`) : ''}${t.pending ? ' · confirming' : ''}${t.error ? ' · ' + esc(t.error) : ''}${t.skipped ? ' · ' + esc(t.skipped) : ''}</div>`).join(''); }
    const RT = a.retire; $('p-retire').hidden = !RT;
    if (RT) setText('p-retire-text', `${a.status === 'retired' ? 'Retired' : 'Retiring'}${RT.at ? ' ' + ago(RT.at) : ''} (${RT.reason || 'operator'}). Inventory unwound for ${fmtSol(RT.recoveredSol, 4)} + ${fmtEth(RT.recoveredEth, 5)}; ${RT.repaid ? fmtSol(RT.repaid.sol, 4) + ' repaid to the pool' : 'nothing repaid yet'}${RT.depositRefund ? `, ${fmtSol(RT.depositRefund.sol, 4)} of the deposit refunded to the dev` : ''}${RT.writtenOffSol ? `, ${fmtSol(RT.writtenOffSol, 4)} written off by the pool` : ''}.`);
    $('p-error').hidden = !a.error; setText('p-error-text', a.error ? a.error + (a.diagnosis ? ' ' + a.diagnosis : '') : '');
    // every transfer the payment wallet saw: the deposit's, late ones (after settlement) and foreign ones (a wallet other than the declared one), the last two refunded to their sender
    const P = [...(a.payment?.txs || []), ...(a.payment?.foreign || []).map(f => ({ ...f, foreign: true }))].sort((x, y) => Date.parse(x.at) - Date.parse(y.at)); $('p-payments').hidden = !P.length;
    if (P.length) { const F = a.payment.foreign || []; setText('p-payments-note', `${fmtSol(a.payment.receivedSol, 4)} received${a.payment.overpaidSol ? ` · ${fmtSol(a.payment.overpaidSol, 4)} over, refunded with the deposit` : ''}${F.length ? ` · ${F.length} payment${F.length === 1 ? '' : 's'} from other wallets, refunded` : ''}`);
      const txLink = tx => !tx ? '' : /^demo-/.test(tx) ? esc(tx) : `<a href="https://solscan.io/tx/${esc(tx)}" target="_blank" rel="noopener">${short(tx)}</a>`;
      const tag = t => t.foreign ? ` <span class="label" style="font-size:9px" title="not from the declared wallet; refunded to its sender">other wallet · ${t.refund?.pending ? 'refund confirming' : t.refund?.tx ? 'refunded' : t.refund?.skipped ? 'dust, not refundable' : t.error ? 'refund retrying' : 'refund queued'}</span>` : t.late ? ' <span class="label" style="font-size:9px">late · refunded</span>' : '';
      $('p-payment-rows').innerHTML = P.map(t => `<tr${t.late || t.foreign ? ' style="opacity:.55" title="' + (t.foreign ? 'sent from a wallet other than the declared one; not counted, refunded to its sender' : 'arrived after the deposit was complete; refunded to its sender') + '"' : ''}><td class="num"><a href="https://solscan.io/account/${esc(t.from)}" target="_blank" rel="noopener">${short(t.from)}</a></td><td class="r num">${fmtSol(t.sol, 4)}${tag(t)}</td><td>${ago(t.at)}</td><td>${txLink(t.tx)}${t.foreign && t.refund?.tx ? ' → ' + txLink(t.refund.tx) : ''}</td></tr>`).join(''); }
  }
  // Pay with Phantom: the terminal's Solana path — a SystemProgram transfer built in the page, blockhash from /api/chain/blockhash, signAndSendTransaction
  const pErr = m => { const e = $('p-pay-err'); e.hidden = !m; e.textContent = m || ''; }, pOk = m => { const e = $('p-pay-ok'); e.hidden = !m; e.innerHTML = m || ''; };
  let payBusy = false;
  async function payPhantom() {
    const a = paidPage; if (!a || payBusy || a.status !== 'pending_payment') return; pErr(''); pOk(''); payBusy = true; $('p-pay-phantom').disabled = true;
    try {
      const p = window.phantom?.solana ?? window.solana; if (!p?.connect) throw Error('No Solana wallet found. Install Phantom (phantom.app) or Solflare, or send the SOL to the address above from any wallet you control.');
      const owed = Math.max(0, a.payment.requiredSol - a.payment.receivedSol); if (!(owed > 0)) throw Error('the deposit is already complete');
      const web3 = await loadWeb3(); const r = await p.connect(); const from = new web3.PublicKey(r.publicKey.toString());
      if (a.payment.expectedFrom && from.toBase58() !== a.payment.expectedFrom) throw Error(`This launch must be paid from ${short(a.payment.expectedFrom)}, the wallet declared when it was created; Phantom is on ${short(from.toBase58())}. Switch accounts, or send from the declared wallet manually. A payment from any other wallet is refunded and does not count.`);   // the server would refund it anyway; this saves the round trip and the fee
      const { blockhash } = await get('/api/chain/blockhash');
      const tx = new web3.Transaction({ recentBlockhash: blockhash, feePayer: from }).add(web3.SystemProgram.transfer({ fromPubkey: from, toPubkey: new web3.PublicKey(a.payment.address), lamports: Math.ceil(owed * 1e9) }));
      const { signature } = await p.signAndSendTransaction(tx);
      pOk(`Sent ${owed.toFixed(4)} SOL · <a href="https://solscan.io/tx/${signature}" target="_blank" rel="noopener" style="color:inherit;border-bottom:1px dotted currentColor">${short(signature)}</a> · the payment watcher credits it within a minute; this page follows.`);
    } catch (e) { pErr(e?.message || String(e)); } finally { payBusy = false; $('p-pay-phantom').disabled = false; }
  }
  async function simulatePay() {
    const a = paidPage; if (!a || payBusy) return; pErr(''); pOk(''); payBusy = true;
    try { const owed = Math.max(0, a.payment.requiredSol - a.payment.receivedSol); const r = await fetch('/api/demo/pay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: a.id, from: a.payment.expectedFrom || demoDev(), sol: +owed.toFixed(6) }) }); const j = await r.json(); if (!r.ok) throw Error(j.error || r.status); paidPage = j; renderPaid(j); }   // from the declared wallet: a demo payment from any other wallet would be foreign and refunded, exactly as on chain
    catch (e) { pErr(e?.message || String(e)); } finally { payBusy = false; }
  }
  $('p-pay-phantom').addEventListener('click', payPhantom); $('p-pay-demo').addEventListener('click', simulatePay);

  // ---- polling ----
  const get = async (u) => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw Error(r.status); return r.json(); };
  async function tick() {
    try {
      if (view.name === 'home' || view.name === 'coin') render(await get('/api/state?range=' + range + (view.name === 'coin' ? '&coin=' + view.id : '')));
      // the quote (cached 5 s server-side) is read on every view: it says whether paid launches are on, which drives the header badge and the "v2 coming soon" strip everywhere
      if (view.name === 'home') { const [c, a, p, q] = await Promise.all([get('/api/coins'), get('/api/auctions'), get('/api/paid').catch(() => null), get('/api/paid/quote').catch(() => null)]); renderCoins(c); if (q) renderQuote(q); if (p) renderPaidList(p); renderAuctions(a); get('/api/flywheel').then(renderFlywheel).catch(() => {}); get('/api/pool').then(renderReserve).catch(() => {}); }
      if (view.name === 'auctions' || view.name === 'launch') { const [c, a, q, p] = await Promise.all([get('/api/coins').catch(() => null), get('/api/auctions'), get('/api/paid/quote').catch(() => null), view.name === 'auctions' ? get('/api/paid').catch(() => null) : null]); if (c) noteCoins(c.coins || []); if (q) renderQuote(q); if (p) renderPaidList(p); renderAuctions(a); }
      if (view.name === 'auction') {
        const j = await get('/api/auctions/' + view.id);
        if (j.mode === 'paid') {
          paidPage = j; $('view-auction').hidden = true; $('view-paid').hidden = false; renderPaid(j);
          // a live v2 coin: its mirror block above the timeline, fed by the coin's own state on this same tick (the coin view's cadence and range)
          const cid = mirrorCoinOf(j), s = cid ? await get('/api/state?range=' + range + '&coin=' + cid).catch(() => null) : null;
          if (s?.coin?.id === cid) { mountMirror(cid); render(s); } else mountMirror(null);   // a retired coin is no longer polled (its state comes back without a coin): no block
        } else { paidPage = null; $('view-paid').hidden = true; $('view-auction').hidden = false; renderAuction(j); mountMirror(null); }
      }
      if (view.name === 'auction' || view.name === 'coin') get('/api/paid/quote').then(renderQuote).catch(() => {});
      if (view.name !== 'home' && view.name !== 'coin') { const s = await get('/api/state?range=' + range); if (mirrorId) renderPill(s); else render(s); }   // header status pill (the flagship); with a coin's mirror mounted only the pill, never the block
    } catch {}
  }
  document.querySelectorAll('.ranges button[data-range]').forEach(b => b.addEventListener('click', () => { range = b.dataset.range; document.querySelectorAll('.ranges button[data-range]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); tick(); }));   // the chart's range only: the list sorters share the .ranges look but have their own handler
  document.addEventListener('click', async e => { const b = e.target.closest('[data-copy]'); if (!b) return; const t = $(b.dataset.copy).textContent; if (!/^[A-Za-z0-9x]{20,}$/.test(t)) return; try { await navigator.clipboard.writeText(t); b.textContent = 'copied'; setTimeout(() => (b.textContent = 'copy'), 1200); } catch {} });
  window.addEventListener('resize', () => state && !$('view-coin').hidden && draw(state.series || [], state.band || 0.05));
  route(); setInterval(tick, 3000);
})();
