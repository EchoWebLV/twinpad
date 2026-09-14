
(() => {
  const $ = id => document.getElementById(id);
  const fmtUsd = n => n == null ? '—' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'k' : '$' + n.toFixed(0);
  const fmtPrice = p => p == null ? '—' : '$' + (p < 1e-4 ? p.toExponential(3) : p.toFixed(p < 0.01 ? 6 : 4));
  const short = a => a && a.length > 16 ? a.slice(0, 6) + '…' + a.slice(-4) : (a ?? '');
  let range = '6h', state = null;
  const setText = (id, t) => { const el = $(id); if (el && el.textContent !== t) el.textContent = t; };

  function render(s) {
    state = s;
    const live = s.status === 'live';
    document.body.classList.toggle('prelaunch', !live);
    const pill = $('status'); pill.className = 'pill ' + (live ? (s.inBand ? 'live' : 'off') : 'wait');
    setText('status-text', live ? (s.inBand ? 'Live · mirrored' : 'Live · closing the gap') : (s.status === 'starting' ? 'Reading the chains' : 'Launching soon'));
    if (s.meta) { setText('coin-name', s.meta.name ?? 'Twine'); setText('coin-symbol', s.meta.symbol ? '$' + s.meta.symbol : ''); if (s.meta.image) { const img = $('coin-img'); img.src = s.meta.image; img.hidden = false; }
      const soc = [['X', s.meta.twitter], ['Telegram', s.meta.telegram], ['Website', s.meta.website]].filter(x => x[1]).map(([l, u]) => `<a href="${u}" target="_blank" rel="noopener">${l}</a>`).join(' · '); $('socials').innerHTML = soc; if (s.meta.twitter) $('x-link').href = s.meta.twitter; }
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
    }
    // balance needle: pump above the middle when pump is the expensive side; band = ±5%
    if (s.gap != null) { const signed = (s.expensive === 'pump' ? -1 : 1) * Math.min(s.gap, 0.25); const pct = 50 + signed / 0.25 * 45; const n = $('needle'); if (window.matchMedia('(max-width:900px)').matches) { n.style.left = 'calc(' + pct + '% - 3px)'; n.style.top = ''; } else { n.style.top = 'calc(' + pct + '% - 3px)'; n.style.left = ''; } n.style.background = s.inBand ? 'var(--ok)' : 'var(--bad)'; }
    setText('spine-top', s.pump ? fmtUsd(s.pump.fdv) : '—'); setText('spine-bottom', s.pons ? fmtUsd(s.pons.fdv) : '—');
    setText('band-note', live ? (s.inBand ? 'Inside the 5% mirror band.' : 'Outside the band: the maker is closing it.') : 'The green band is the 5% mirror target.');
    const st = s.stats || {}; setText('st-inband', st.inBandPct == null ? '—' : st.inBandPct.toFixed(1) + '%'); setText('st-maxgap', st.maxGap == null ? '—' : (st.maxGap * 100).toFixed(1) + '%'); setText('st-high', fmtUsd(st.high)); setText('st-low', fmtUsd(st.low));
    setText('updated', s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : '—');
    draw(s.series || [], s.band || 0.05);
  }

  function draw(series, band) {
    const c = $('chart'), dpr = window.devicePixelRatio || 1, W = c.clientWidth || 1200, H = 280;
    c.width = W * dpr; c.height = H * dpr; const ctx = c.getContext('2d'); ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement), col = v => css.getPropertyValue(v).trim();
    ctx.clearRect(0, 0, W, H);
    const padL = 56, padR = 12, padT = 12, padB = 24;
    if (series.length < 2) { ctx.fillStyle = col('--dim'); ctx.font = '13px ' + col('--sans'); ctx.fillText(series.length ? 'collecting…' : 'waiting for launch', padL, H / 2); return; }
    const t0 = series[0].t, t1 = series[series.length - 1].t, vals = series.flatMap(p => [p.pump, p.pons]);
    let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.08 || hi * 0.05; lo -= pad; hi += pad;
    const x = t => padL + (t - t0) / Math.max(1, t1 - t0) * (W - padL - padR), y = v => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    ctx.strokeStyle = col('--line'); ctx.lineWidth = 1; ctx.fillStyle = col('--muted'); ctx.font = '11px ' + col('--mono');
    for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4, yy = y(v); ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke(); ctx.fillText(fmtUsd(v), 4, yy + 4); }
    // in-band shading: between the two lines where they are within the band
    ctx.fillStyle = 'rgba(198,232,20,.12)';
    for (let i = 1; i < series.length; i++) { const a = series[i - 1], b = series[i]; const g = Math.max(a.pump, a.pons) / Math.min(a.pump, a.pons) - 1; if (g > band) continue; ctx.beginPath(); ctx.moveTo(x(a.t), y(a.pump)); ctx.lineTo(x(b.t), y(b.pump)); ctx.lineTo(x(b.t), y(b.pons)); ctx.lineTo(x(a.t), y(a.pons)); ctx.closePath(); ctx.fill(); }
    for (const [key, color] of [['pump', col('--sol')], ['pons', col('--rh')]]) { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.beginPath(); series.forEach((p, i) => i ? ctx.lineTo(x(p.t), y(p[key])) : ctx.moveTo(x(p.t), y(p[key]))); ctx.stroke(); const last = series[series.length - 1]; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x(last.t), y(last[key]), 3.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = col('--muted'); ctx.font = '11px ' + col('--mono'); const tf = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ctx.fillText(tf(t0), padL, H - 6); const e = tf(t1); ctx.fillText(e, W - padR - ctx.measureText(e).width, H - 6);
  }

  async function tick() { try { const r = await fetch('/api/state?range=' + range, { cache: 'no-store' }); if (r.ok) render(await r.json()); } catch {} }
  document.querySelectorAll('.ranges button').forEach(b => b.addEventListener('click', () => { range = b.dataset.range; document.querySelectorAll('.ranges button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); tick(); }));
  document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => { const t = $(b.dataset.copy).textContent; if (!/^[A-Za-z0-9x]{20,}$/.test(t)) return; try { await navigator.clipboard.writeText(t); b.textContent = 'copied'; setTimeout(() => (b.textContent = 'copy'), 1200); } catch {} }));
  window.addEventListener('resize', () => state && draw(state.series || [], state.band || 0.05));
  tick(); setInterval(tick, 3000);
})();
