/**
 * Peg simulation: the live maker rule against candidate rules, under one-way order flow like $TWINE's
 * (Solana sellers, Robinhood buyers) and a few other regimes. Rules:
 *   live          buy the cheap side whenever the gap is open, no limit (what runs in production)
 *   ceil300       same, but the peg may hold at most $300 (at cost) of tokens it bought per side; sells release it
 *   ceil300+seed  ceiling, plus the ETH front opens a Pons position at launch even when parity does not call for one
 *   twoleg+seed   seeded, ceiling, and the cheap-side buy only happens when the expensive-side sell went through
 *   twoleg        strict two-legged rule without the seed
 * Money out (top-ups) only happens inside the per-coin cap or once the coin has repaid everything (recover.ts canTopUp).
 *
 * Curves are the real ones: pump.fun constant product (30 SOL / 1.073e9 virtual, 1.25% fee, +0.5% PumpPortal on
 * our trades) and Pons launch config 0 (1e9 supply, 1.68 ETH phantom quote, 1% fee, 2% creator tax to our maker).
 * Maker knobs are the production profile (band 5%, clip $25 scaled up to 3x, floors 0.05 SOL / 0.003 ETH,
 * keep 4 clips, harvest at +10%, top-ups 0.5 SOL x6 / 0.02 ETH x10, loss guard $150).
 * Creator fee income on pump.fun is left out on both sides (conservative; the same for both rules).
 *
 *   npx tsx scripts/sim-peg.ts            # all scenarios, 40 seeds each
 *   npx tsx scripts/sim-peg.ts twine 5    # one scenario, 5 seeds, per-seed rows
 */

const SOL_USD = 102.75;
const ETH_USD = 2532.6;
const TICK_S = 3;
const HOURS = 3;
const TICKS = Math.round((HOURS * 3600) / TICK_S);

const CFG = {
  band: 0.05,
  clipUsd: 25,
  minSol: 0.05,
  minEth: 0.003,
  keepClips: 4,
  margin: 0.1,
  topupSol: 0.5,
  maxTopupSol: 3,
  topupEth: 0.02,
  maxTopupEth: 0.2,
  maxLossUsd: 150,
  frontSol: 6.69,
  devBuySol: 6.52,
  frontEth: 0.1,
  makerCashEth: 0.01,
};

// ---- curves -------------------------------------------------------------------------------------------------
class Curve {
  constructor(public q: number, public t: number, public feeBps: number, public taxBps = 0) {}
  price() { return this.q / this.t; }
  fdvUsd(supply: number, quoteUsd: number) { return this.price() * supply * quoteUsd; }
  /** quote in -> tokens out; returns {tokens, tax} where tax (quote units) goes to the creator */
  buy(quoteIn: number, extraFeeBps = 0) {
    const fee = quoteIn * (this.feeBps + extraFeeBps) / 1e4;
    const tax = quoteIn * this.taxBps / 1e4;
    const net = quoteIn - fee - tax;
    const tokens = (net * this.t) / (this.q + net);
    this.q += net; this.t -= tokens;
    return { tokens, tax };
  }
  /** tokens in -> quote out (net of fee and tax) */
  sell(tokensIn: number, extraFeeBps = 0) {
    const gross = (tokensIn * this.q) / (this.t + tokensIn);
    this.q -= gross; this.t += tokensIn;
    const fee = gross * (this.feeBps + extraFeeBps) / 1e4;
    const tax = gross * this.taxBps / 1e4;
    return { quote: gross - fee - tax, tax };
  }
  quoteForTokens(tokens: number) { return (tokens * this.q) / (this.t + tokens); }
  tokensForQuote(quote: number) { return (quote * this.t) / (this.q + quote); }
}

// ---- rng ----------------------------------------------------------------------------------------------------
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- scenarios: outside order flow per tick -----------------------------------------------------------------
interface Flow { pumpBuySol?: number; pumpSellFrac?: number; ponsBuyEth?: number; ponsSellFrac?: number }
type Scenario = { name: string; note: string; preWaveSol: number; preWaveEth: number; flow: (r: () => number, tick: number) => Flow };
const SCENARIOS: Scenario[] = [
  {
    name: "twine", note: "SOL holders dump, RH keeps buying (the $TWINE post)", preWaveSol: 15, preWaveEth: 0.4,
    flow: (r) => ({ pumpSellFrac: r() < 0.05 ? 0.003 + r() * 0.006 : 0, ponsBuyEth: r() < 0.05 ? 0.003 + r() * 0.01 : 0 }),
  },
  {
    name: "mirror", note: "RH holders dump, SOL keeps buying", preWaveSol: 15, preWaveEth: 0.4,
    flow: (r) => ({ ponsSellFrac: r() < 0.05 ? 0.003 + r() * 0.006 : 0, pumpBuySol: r() < 0.05 ? 0.08 + r() * 0.24 : 0 }),
  },
  {
    name: "noise", note: "two-way flow on both chains, no trend", preWaveSol: 15, preWaveEth: 0.4,
    flow: (r) => ({
      pumpBuySol: r() < 0.05 ? 0.05 + r() * 0.2 : 0, pumpSellFrac: r() < 0.05 ? 0.003 + r() * 0.006 : 0,
      ponsBuyEth: r() < 0.05 ? 0.002 + r() * 0.006 : 0, ponsSellFrac: r() < 0.05 ? 0.003 + r() * 0.006 : 0,
    }),
  },
  {
    name: "dump-both", note: "holders dump on both chains", preWaveSol: 15, preWaveEth: 0.4,
    flow: (r) => ({ pumpSellFrac: r() < 0.05 ? 0.003 + r() * 0.006 : 0, ponsSellFrac: r() < 0.05 ? 0.003 + r() * 0.006 : 0 }),
  },
  {
    name: "sol-only-dump", note: "SOL holders dump, RH quiet", preWaveSol: 15, preWaveEth: 0.4,
    flow: (r) => ({ pumpSellFrac: r() < 0.05 ? 0.003 + r() * 0.006 : 0 }),
  },
];

// same rule as recover.ts canTopUp: inside the per-coin cap, or the coin has already repaid everything fronted plus this top-up
function canTopUp(frontedTotal: number, repaid: number, topups: number, topup: number, max: number) {
  if (topups + topup <= max + 1e-12) return true;
  return repaid - (frontedTotal + topup) >= -1e-12;
}

// ---- one run ------------------------------------------------------------------------------------------------
interface Rule { name: string; twoLegged: boolean; ceilUsd: number; seedPons: boolean; symmetric?: boolean }
// ceilUsd: cap (at cost) on tokens the peg has BOUGHT per side, on top of the opening position; sells release it first.
// seedPons: item 4 — open a Pons position with the ETH front even when parity does not call for one.
const RULES: Rule[] = [
  { name: "live", twoLegged: false, ceilUsd: Infinity, seedPons: false },
  { name: "ceil300", twoLegged: false, ceilUsd: 300, seedPons: false },
  { name: "ceil300+seed", twoLegged: false, ceilUsd: 300, seedPons: true },
  { name: "twoleg+seed", twoLegged: true, ceilUsd: 300, seedPons: true },
  { name: "twoleg", twoLegged: true, ceilUsd: 300, seedPons: false },
  // proper two-sided book: the same dollars on each chain, half tokens half cash, no top-ups, buys capped by the side's own cash
  { name: "symmetric", twoLegged: false, ceilUsd: Infinity, seedPons: true, symmetric: true },
];

interface Result {
  pnlUsd: number; frontedUsd: number; returnedUsd: number; endValueUsd: number; topupsUsd: number;
  avgGap: number; inBandPct: number; trades: number; halted: boolean; lowSolTicks: number; noTokTicks: number;
  endTokPump: number; endTokPons: number;
}

function run(sc: Scenario, rule: Rule, seed: number): Result {
  const r = rng(seed);
  const pump = new Curve(30, 1_073_000_000, 125);
  const pons = new Curve(1.68, 1_000_000_000, 100, 200);
  const SUPPLY = 1e9;

  // launch: dev buy on pump.fun, Pons opening buy sized to the same FDV
  const totalUsd = CFG.frontSol * SOL_USD + CFG.frontEth * ETH_USD;
  const frontSol = rule.symmetric ? totalUsd / 2 / SOL_USD : CFG.frontSol;
  const frontEth = rule.symmetric ? totalUsd / 2 / ETH_USD : CFG.frontEth;
  const devBuySol = rule.symmetric ? (frontSol - 0.13) / 2 : CFG.devBuySol;
  const m = { sol: frontSol - 0.04, eth: frontEth, tokPump: 0, tokPons: 0, escrowEth: 0 };
  const b = pump.buy(devBuySol, 50); m.sol -= devBuySol; m.tokPump += b.tokens;
  const targetFdv = pump.fdvUsd(SUPPLY, SOL_USD);
  // solve quote-in on Pons for the same price
  const targetPrice = targetFdv / SUPPLY / ETH_USD;
  const k = pons.q * pons.t; const q1 = Math.sqrt(k * targetPrice); const net = q1 - pons.q;
  const ethIn = rule.symmetric ? (m.eth - CFG.makerCashEth) / 2 : rule.seedPons ? m.eth - CFG.makerCashEth : Math.min(m.eth - CFG.makerCashEth, net / (1 - 0.03));
  const pb = pons.buy(Math.max(0, ethIn)); m.eth -= Math.max(0, ethIn); m.tokPons += pb.tokens; m.escrowEth += pb.tax;
  const entryPump = pump.price(), entryPons = pons.price();
  const openTokPump = m.tokPump, openTokPons = m.tokPons;
  const bought = { pumpUsd: 0, ponsUsd: 0 }; // peg purchases at cost, released by sells

  let fronted = { sol: frontSol, eth: frontEth }, repaid = { sol: 0, eth: 0 }, topups = { sol: 0, eth: 0 };
  let trades = 0, gapSum = 0, inBand = 0, halted = false, lowSolTicks = 0, noTokTicks = 0;

  // outsiders: a pre-wave of buys gives them inventory to dump later
  const out = { tokPump: 0, tokPons: 0 };
  out.tokPump += pump.buy(sc.preWaveSol).tokens;
  const pw = pons.buy(sc.preWaveEth); out.tokPons += pw.tokens; m.escrowEth += pw.tax;

  const clipTokens = (curve: Curve, quoteUsd: number, usd: number) => curve.tokensForQuote(usd / quoteUsd);
  const keepSol = CFG.minSol + (CFG.keepClips * CFG.clipUsd) / SOL_USD;
  const keepEth = CFG.minEth + (CFG.keepClips * CFG.clipUsd) / ETH_USD;

  for (let tick = 0; tick < TICKS; tick++) {
    // ---- outside flow
    const f = sc.flow(r, tick);
    if (f.pumpBuySol) out.tokPump += pump.buy(f.pumpBuySol).tokens;
    if (f.pumpSellFrac && out.tokPump > 0) { const t = out.tokPump * f.pumpSellFrac; out.tokPump -= t; pump.sell(t); }
    if (f.ponsBuyEth) { const x = pons.buy(f.ponsBuyEth); out.tokPons += x.tokens; m.escrowEth += x.tax; }
    if (f.ponsSellFrac && out.tokPons > 0) { const t = out.tokPons * f.ponsSellFrac; out.tokPons -= t; const x = pons.sell(t); m.escrowEth += x.tax; }

    // ---- fee claim once a minute (Pons tax to the maker wallet)
    if (tick % 20 === 0 && m.escrowEth >= 0.002) { m.eth += m.escrowEth; m.escrowEth = 0; }

    if (halted) continue;
    // ---- loss guard
    const held = m.sol * SOL_USD + m.eth * ETH_USD + pump.quoteForTokens(m.tokPump) * SOL_USD + pons.quoteForTokens(m.tokPons) * ETH_USD;
    const frontedUsd = fronted.sol * SOL_USD + fronted.eth * ETH_USD + topups.sol * SOL_USD + topups.eth * ETH_USD;
    const back = repaid.sol * SOL_USD + repaid.eth * ETH_USD;
    if (frontedUsd - held - back > CFG.maxLossUsd) { halted = true; continue; }

    // ---- peg
    const fp = pump.fdvUsd(SUPPLY, SOL_USD), fo = pons.fdvUsd(SUPPLY, ETH_USD);
    const gap = Math.abs(fp - fo) / Math.min(fp, fo);
    gapSum += gap; if (gap <= CFG.band) inBand++;
    if (m.sol < CFG.minSol + CFG.clipUsd / SOL_USD) lowSolTicks++;
    if (m.tokPons < clipTokens(pons, ETH_USD, CFG.clipUsd) / 4 && m.tokPump < clipTokens(pump, SOL_USD, CFG.clipUsd) / 4) noTokTicks++;

    if (process.env.TRACE && tick % 200 === 0) console.log(`t${tick} gap ${(gap*100).toFixed(1)} fp ${fp.toFixed(0)} fo ${fo.toFixed(0)} sol ${m.sol.toFixed(3)} eth ${m.eth.toFixed(4)} tokPump ${(m.tokPump/1e6).toFixed(2)}M tokPons ${(m.tokPons/1e6).toFixed(2)}M (open ${(openTokPons/1e6).toFixed(2)}M) repaid ${repaid.sol.toFixed(2)}/${repaid.eth.toFixed(4)} topups ${topups.sol}/${topups.eth}`);
    if (gap > CFG.band) {
      const scale = Math.min(3, gap / CFG.band);
      const usd = CFG.clipUsd * scale;
      const expensive = fp > fo ? "pump" : "pons";
      let sold = false;
      if (expensive === "pump") {
        const want = clipTokens(pump, SOL_USD, usd); const can = Math.min(want, m.tokPump);
        if (can >= clipTokens(pump, SOL_USD, CFG.clipUsd) / 4) { const x = pump.sell(can, 50); m.tokPump -= can; m.sol += x.quote; bought.pumpUsd = Math.max(0, bought.pumpUsd - x.quote * SOL_USD); trades++; sold = true; }
      } else {
        const want = clipTokens(pons, ETH_USD, usd); const can = Math.min(want, m.tokPons);
        if (can >= clipTokens(pons, ETH_USD, CFG.clipUsd) / 4) { const x = pons.sell(can); m.tokPons -= can; m.eth += x.quote; m.escrowEth += x.tax; bought.ponsUsd = Math.max(0, bought.ponsUsd - x.quote * ETH_USD); trades++; sold = true; }
      }
      const mayBuy = rule.twoLegged ? sold : true;
      if (mayBuy) {
        if (expensive === "pump") {
          // buy on Pons
          const ceilingOk = bought.ponsUsd + usd <= rule.ceilUsd;
          let eth = usd / ETH_USD;
          if (!rule.symmetric && ceilingOk && m.eth - eth < CFG.minEth && canTopUp(fronted.eth + topups.eth, repaid.eth, topups.eth, CFG.topupEth, CFG.maxTopupEth)) {
            topups.eth += CFG.topupEth; m.eth += CFG.topupEth;
          }
          eth = Math.min(eth, m.eth - CFG.minEth);
          if (ceilingOk && eth > usd / ETH_USD / 4) { const x = pons.buy(eth); m.eth -= eth; m.tokPons += x.tokens; m.escrowEth += x.tax; bought.ponsUsd += eth * ETH_USD; trades++; }
        } else {
          const ceilingOk = bought.pumpUsd + usd <= rule.ceilUsd;
          let sol = usd / SOL_USD;
          if (!rule.symmetric && ceilingOk && m.sol - sol < CFG.minSol && canTopUp(fronted.sol + topups.sol, repaid.sol, topups.sol, CFG.topupSol, CFG.maxTopupSol)) {
            topups.sol += CFG.topupSol; m.sol += CFG.topupSol;
          }
          sol = Math.min(sol, m.sol - CFG.minSol);
          if (ceilingOk && sol > usd / SOL_USD / 4) { const x = pump.buy(sol, 50); m.sol -= sol; m.tokPump += x.tokens; bought.pumpUsd += sol * SOL_USD; trades++; }
        }
      }
    } else {
      // harvest: inside the band, a side trading above entry while its front is not repaid sells one clip
      if (repaid.sol < fronted.sol && pump.price() >= entryPump * (1 + CFG.margin) && m.tokPump > 0) {
        const can = Math.min(clipTokens(pump, SOL_USD, CFG.clipUsd), m.tokPump); const x = pump.sell(can, 50); m.tokPump -= can; m.sol += x.quote; trades++;
      }
      if (repaid.eth < fronted.eth && pons.price() >= entryPons * (1 + CFG.margin) && m.tokPons > 0) {
        const can = Math.min(clipTokens(pons, ETH_USD, CFG.clipUsd), m.tokPons); const x = pons.sell(can); m.tokPons -= can; m.eth += x.quote; m.escrowEth += x.tax; trades++;
      }
    }
    // sweep quote above the keep level back to the pool
    if (m.sol > keepSol) { repaid.sol += m.sol - keepSol; m.sol = keepSol; }
    if (m.eth > keepEth) { repaid.eth += m.eth - keepEth; m.eth = keepEth; }
  }

  // end: liquidate the maker into the curves (what a close would realize) and sweep everything
  const endSol = m.sol + (m.tokPump > 0 ? pump.sell(m.tokPump, 50).quote : 0);
  const endEth = m.eth + m.escrowEth + (m.tokPons > 0 ? pons.sell(m.tokPons).quote : 0);
  const frontedUsd = (fronted.sol + topups.sol) * SOL_USD + (fronted.eth + topups.eth) * ETH_USD;
  const returnedUsd = repaid.sol * SOL_USD + repaid.eth * ETH_USD;
  const endValueUsd = endSol * SOL_USD + endEth * ETH_USD;
  return {
    pnlUsd: returnedUsd + endValueUsd - frontedUsd, frontedUsd, returnedUsd, endValueUsd,
    topupsUsd: topups.sol * SOL_USD + topups.eth * ETH_USD,
    avgGap: gapSum / TICKS, inBandPct: inBand / TICKS, trades, halted, lowSolTicks, noTokTicks,
    endTokPump: m.tokPump, endTokPons: m.tokPons,
  };
}

// ---- main ---------------------------------------------------------------------------------------------------
const only = process.argv[2];
const seeds = Number(process.argv[3] ?? 40);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const fmt = (n: number, d = 0) => n.toFixed(d).padStart(8);
console.log(`ticks ${TICKS} (${HOURS}h at ${TICK_S}s), seeds ${seeds}; front ${CFG.frontSol} SOL + ${CFG.frontEth} ETH, dev buy ${CFG.devBuySol} SOL (symmetric: same total $, split evenly per chain, half in tokens); SOL $${SOL_USD} ETH $${ETH_USD}`);
console.log("");
for (const sc of SCENARIOS) {
  if (only && sc.name !== only) continue;
  console.log(`== ${sc.name}: ${sc.note}`);
  console.log(`   ${"rule".padEnd(13)} ${"pnl $".padStart(8)} ${"fronted".padStart(8)} ${"topups".padStart(8)} ${"back".padStart(8)} ${"endval".padStart(8)} ${"gap%".padStart(8)} ${"inband%".padStart(8)} ${"trades".padStart(8)} ${"halted%".padStart(8)}`);
  for (const rule of RULES) {
    const rs = Array.from({ length: seeds }, (_, i) => run(sc, rule, 1000 + i));
    if (only) for (const [i, x] of rs.entries()) console.log(`   seed ${i} pnl ${x.pnlUsd.toFixed(0)} topups ${x.topupsUsd.toFixed(0)} gap ${(x.avgGap * 100).toFixed(1)} halted ${x.halted} tokPump ${x.endTokPump.toFixed(0)} tokPons ${x.endTokPons.toFixed(0)}`);
    console.log(`   ${rule.name.padEnd(13)} ${fmt(mean(rs.map((x) => x.pnlUsd)))} ${fmt(mean(rs.map((x) => x.frontedUsd)))} ${fmt(mean(rs.map((x) => x.topupsUsd)))} ${fmt(mean(rs.map((x) => x.returnedUsd)))} ${fmt(mean(rs.map((x) => x.endValueUsd)))} ${fmt(mean(rs.map((x) => x.avgGap * 100)), 1)} ${fmt(mean(rs.map((x) => x.inBandPct * 100)), 0)} ${fmt(mean(rs.map((x) => x.trades)))} ${fmt(mean(rs.map((x) => (x.halted ? 100 : 0))), 0)}`);
  }
  console.log("");
}
