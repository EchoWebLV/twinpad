/**
 * Peg simulation across market caps, order-flow regimes and dump sizes. Each cell runs both venues for 3h at the
 * maker's 3s tick, N random seeds, and reports every rule's edge over HOLD (maker off, same flow) in dollars,
 * plus the share of ticks inside the 5% band.
 *
 * Venues (pre-graduation, real parameters): pump.fun curve 30 SOL / 1.073e9 virtual, 1.25% fee (+0.5% PumpPortal on
 * our trades); Pons launch config 0: 1e9 supply, 1.68 ETH phantom, 1% fee, 2% creator tax to our maker, graduates at
 * 4.2 ETH raised. Post-graduation (ASSUMED): PumpSwap pool seeded with 79 SOL + 206.9M tokens at completion
 * (85 SOL raised, 6 SOL migration fee), fee 1.25%; Pons Uniswap v4 pool seeded with the 4.2 ETH swept at the curve's
 * final price, pool fee 0 (launch config 0 reports poolFee 0), no creator tax. Both pools are treated as constant
 * product and scaled to the target FDV with quote depth ∝ √price.
 *
 * Maker rules:
 *   hold       maker off (baseline)
 *   live       production: buy the cheap side whenever the gap is open, top-ups inside the per-coin cap or once repaid
 *   ceil+seed  12-clip per-side cap on tokens the peg bought (sells release it) and an opening Pons position at launch
 *   symmetric  same dollars per chain, half tokens half cash on both, no top-ups, buys limited to the side's cash
 *   scaled     ceil+seed with clip = 0.5% of the shallower venue's quote depth (min $25); keep/top-up/cap in clips
 *   steward    two-sided opening, RESERVE_CLIPS (12) of cash per side fronted once and never topped up (cash is the cap),
 *              harvest at most one clip a minute per side and only 25% over entry; steward-sc = the same with scaled clips
 *   steward+bb steward plus BUYBACK (0.5) of every fee claim bought back on its own chain and burned, never on the expensive side
 *   PUMP_CREATOR_BPS = pump.fun creator share of each trade in bps (0 = not modelled; Pons 2% creator tax is always modelled)
 *   SOLD=1 adds per cell: s = USD the maker sold over the run, t = pool top-ups, b = USD bought back and burned
 * Above launch FDV every rule starts from the same bags (dev buy + seeded Pons position, grown with FDV, minus the
 * front already repaid by harvest sells), so the cells compare maker behaviour and not bag size; the cap rule of
 * recover.ts canTopUp applies as in production. Cells are mark-to-market at the end of the window against HOLD, so
 * in a one-way trend every peg rule shows an opportunity cost (it sells into rises and buys into falls by design).
 *
 *   npx tsx scripts/sim-peg.ts                 # full grid, 20 seeds
 *   npx tsx scripts/sim-peg.ts 1000000 twine   # one FDV (USD, 0 = fresh launch) and/or one scenario
 *   SEEDS=5 TRACE=1 npx tsx scripts/sim-peg.ts 0 twine
 *   SEEDS=1 DEBUG=1 npx tsx scripts/sim-peg.ts 1000000 both-pump   # end-of-run value components per rule
 */

const SOL_USD = 102.75;
const ETH_USD = 2532.6;
const TICK_S = 3;
const HOURS = 3;
const TICKS = Math.round((HOURS * 3600) / TICK_S);
const SUPPLY = 1e9;

const env = (k: string, d: number) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const CFG = {
  band: 0.05, clipUsd: env("CLIP_USD", 25), minSol: 0.05, minEth: 0.003, keepClips: 4, margin: 0.1,
  topupSol: 0.5, maxTopupSol: 3, topupEth: 0.02, maxTopupEth: 0.2, maxLossUsd: env("MAX_LOSS_USD", 150),
  // launch shape; override with FRONT_SOL / DEV_SOL / FRONT_ETH / SEED_ETH (ETH opening buy when seeded) / LOCK_PCT
  frontSol: env("FRONT_SOL", 6.69), devBuySol: env("DEV_SOL", 6.52), frontEth: env("FRONT_ETH", 0.1), makerCashEth: 0.01,
  seedEth: env("SEED_ETH", NaN), // NaN = whole ETH front minus maker cash
  lockPct: env("LOCK_PCT", 0), // share of supply bought on BOTH curves before anything else and never sold
  pumpCreatorBps: env("PUMP_CREATOR_BPS", 0), // pump.fun creator share of each trade, bps (carved out of the 1.25% fee); 0 = not modelled
};

// ---- venues ---------------------------------------------------------------------------------------------------
class Venue {
  constructor(public q: number, public t: number, public feeBps: number, public taxBps: number, public label: string, public creatorBps = 0) {}
  price() { return this.q / this.t; }
  fdv(quoteUsd: number) { return this.price() * SUPPLY * quoteUsd; }
  buy(quoteIn: number, extraFeeBps = 0) {
    const fee = quoteIn * (this.feeBps + extraFeeBps) / 1e4, tax = quoteIn * this.taxBps / 1e4;
    const net = quoteIn - fee - tax, tokens = (net * this.t) / (this.q + net);
    this.q += net; this.t -= tokens;
    return { tokens, tax: tax + quoteIn * this.creatorBps / 1e4 }; // tax = everything that lands in the creator's escrow/vault
  }
  sell(tokensIn: number, extraFeeBps = 0) {
    const gross = (tokensIn * this.q) / (this.t + tokensIn);
    this.q -= gross; this.t += tokensIn;
    const fee = gross * (this.feeBps + extraFeeBps) / 1e4, tax = gross * this.taxBps / 1e4;
    return { quote: gross - fee - tax, tax: tax + gross * this.creatorBps / 1e4 };
  }
  quoteFor(tokens: number) { return (tokens * this.q) / (this.t + tokens); }
  tokensFor(quote: number) { return (quote * this.t) / (this.q + quote); }
}

const PUMP_K = 30 * 1_073_000_000, PUMP_GRAD_Q = 115, PUMP_POOL_Q0 = 79, PUMP_POOL_T0 = 206_900_000;
const PONS_K = 1.68 * SUPPLY, PONS_GRAD_Q = 1.68 + 4.2, PONS_POOL_Q0 = 4.2;
const pumpGradPrice = PUMP_GRAD_Q / (PUMP_K / PUMP_GRAD_Q);
const ponsGradPrice = PONS_GRAD_Q / (PONS_K / PONS_GRAD_Q);
const PUMP_GRAD_FDV = pumpGradPrice * SUPPLY * SOL_USD;
const PONS_GRAD_FDV = ponsGradPrice * SUPPLY * ETH_USD;

const freshPump = () => new Venue(30, 1_073_000_000, 125, 0, "curve", CFG.pumpCreatorBps);
const freshPons = () => new Venue(1.68, SUPPLY, 100, 200, "curve");
/** A pump.fun venue sitting at FDV `fdvUsd` (curve below graduation, PumpSwap pool above). */
function pumpAt(fdvUsd: number): Venue {
  const price = fdvUsd / SUPPLY / SOL_USD;
  if (fdvUsd < PUMP_GRAD_FDV) { const q = Math.sqrt(price * PUMP_K); return new Venue(q, PUMP_K / q, 125, 0, "curve", CFG.pumpCreatorBps); }
  const s = Math.sqrt(price / (PUMP_POOL_Q0 / PUMP_POOL_T0));
  return new Venue(PUMP_POOL_Q0 * s, PUMP_POOL_T0 / s, 125, 0, "pumpswap", CFG.pumpCreatorBps);
}
function ponsAt(fdvUsd: number): Venue {
  const price = fdvUsd / SUPPLY / ETH_USD;
  if (fdvUsd < PONS_GRAD_FDV) { const q = Math.sqrt(price * PONS_K); return new Venue(q, PONS_K / q, 100, 200, "curve"); }
  const t0 = PONS_POOL_Q0 / ponsGradPrice; const s = Math.sqrt(price / ponsGradPrice);
  return new Venue(PONS_POOL_Q0 * s, t0 / s, 0, 0, "v4");
}
/** real tokens outside the venue (pump.fun's 73M virtual tokens excluded) */
function circulating(v: Venue, isPump: boolean) { return SUPPLY - (v.t - (isPump && v.label === "curve" ? 73_000_000 : 0)); }

// ---- rng --------------------------------------------------------------------------------------------------------
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- scenarios ----------------------------------------------------------------------------------------------------
// dump = share of outsiders' holdings sold on that side over the run; buy = fresh quote bought on that side as a
// multiple of the venue's starting quote depth.
interface Scenario { name: string; note: string; dumpPump: number; dumpPons: number; buyPump: number; buyPons: number }
function scenarios(i: number): Scenario[] {
  return [
    { name: "twine", note: "SOL holders dump, RH buys", dumpPump: i, dumpPons: 0, buyPump: 0, buyPons: i },
    { name: "mirror", note: "RH holders dump, SOL buys", dumpPump: 0, dumpPons: i, buyPump: i, buyPons: 0 },
    { name: "sol-dump", note: "SOL holders dump, RH quiet", dumpPump: i, dumpPons: 0, buyPump: 0, buyPons: 0 },
    { name: "rh-dump", note: "RH holders dump, SOL quiet", dumpPump: 0, dumpPons: i, buyPump: 0, buyPons: 0 },
    { name: "both-dump", note: "both sides dump", dumpPump: i, dumpPons: i, buyPump: 0, buyPons: 0 },
    { name: "both-pump", note: "both sides get bought", dumpPump: 0, dumpPons: 0, buyPump: i, buyPons: i },
    { name: "noise", note: "two-way flow both sides", dumpPump: i / 2, dumpPons: i / 2, buyPump: i / 2, buyPons: i / 2 },
  ];
}

// ---- rules ----------------------------------------------------------------------------------------------------------
interface Rule {
  name: string; on: boolean; ceilClips: number; seedPons: boolean; symmetric: boolean; scaled: boolean;
  /** steward: no pool top-ups ever; a per-side cash reserve of `reserveClips` clips is fronted at launch and kept in the coin */
  noTopup: boolean; reserveClips: number;
  /** harvest (front repayment sells inside the band) at most once per `harvestEvery` ticks per side, only `margin` over entry */
  harvestEvery: number; margin: number;
  /** share of every fee claim that buys the coin back on the claim's own chain and burns it (never while that chain is the expensive side) */
  buyback: number;
}
const base = { noTopup: false, reserveClips: 0, harvestEvery: 1, margin: CFG.margin, buyback: 0 };
const RULES: Rule[] = [
  { name: "hold", on: false, ceilClips: 0, seedPons: false, symmetric: false, scaled: false, ...base },
  { name: "live", on: true, ceilClips: Infinity, seedPons: false, symmetric: false, scaled: false, ...base },
  { name: "ceil+seed", on: true, ceilClips: 12, seedPons: true, symmetric: false, scaled: false, ...base },
  { name: "symmetric", on: true, ceilClips: Infinity, seedPons: true, symmetric: true, scaled: false, ...base },
  { name: "scaled", on: true, ceilClips: 12, seedPons: true, symmetric: false, scaled: true, ...base },
  // steward: two-sided opening, one cash reserve per side and no top-ups (cash is the cap), harvest one clip a minute at +25%
  { name: "steward", on: true, ceilClips: Infinity, seedPons: true, symmetric: false, scaled: false, noTopup: true, reserveClips: env("RESERVE_CLIPS", 12), harvestEvery: 20, margin: 0.25, buyback: 0 },
  { name: "steward-sc", on: true, ceilClips: Infinity, seedPons: true, symmetric: false, scaled: true, noTopup: true, reserveClips: env("RESERVE_CLIPS", 12), harvestEvery: 20, margin: 0.25, buyback: 0 },
  // steward+bb: steward plus half of every fee claim bought back on its own chain and burned
  { name: "steward+bb", on: true, ceilClips: Infinity, seedPons: true, symmetric: false, scaled: false, noTopup: true, reserveClips: env("RESERVE_CLIPS", 12), harvestEvery: 20, margin: 0.25, buyback: env("BUYBACK", 0.5) },
];

// same rule as recover.ts canTopUp
function canTopUp(frontedTotal: number, repaid: number, topups: number, topup: number, max: number) {
  if (topups + topup <= max + 1e-12) return true;
  return repaid - (frontedTotal + topup) >= -1e-12;
}

interface Result { valueDelta: number; topupsUsd: number; inBand: number; avgGap: number; trades: number; halted: boolean; soldUsd: number; outsideBuyUsd: number; burnedUsd: number; repaidUsd: number }

function run(fdv: number, sc: Scenario, rule: Rule, seed: number): Result {
  const r = rng(seed);
  const launch = fdv <= 0;
  const pump = launch ? freshPump() : pumpAt(fdv);
  const pons = launch ? freshPons() : ponsAt(fdv);

  const totalUsd = CFG.frontSol * SOL_USD + CFG.frontEth * ETH_USD;
  const frontSol = rule.symmetric ? totalUsd / 2 / SOL_USD : CFG.frontSol;
  const frontEth = rule.symmetric ? totalUsd / 2 / ETH_USD : CFG.frontEth;
  const devSol = rule.symmetric ? (frontSol - 0.13) / 2 : CFG.devBuySol;
  let lockTax = 0;
  const seedEth = rule.symmetric ? (frontEth - CFG.makerCashEth) / 2 : rule.seedPons ? (Number.isNaN(CFG.seedEth) ? frontEth - CFG.makerCashEth : CFG.seedEth) : 0;
  if (CFG.lockPct > 0) { // locked dev allocation: on the curve as a buy, off the table for everyone
    const lock = CFG.lockPct * SUPPLY;
    pump.buy((pump.q * lock) / (pump.t - lock) / (1 - 0.0125));
    lockTax = pons.buy((pons.q * lock) / (pons.t - lock) / 0.97).tax;
  }
  const m = { sol: frontSol - 0.04, eth: frontEth, tokPump: 0, tokPons: 0, escrowEth: lockTax, escrowSol: 0 };
  const fronted = { sol: frontSol, eth: frontEth }, repaid = { sol: 0, eth: 0 }, topups = { sol: 0, eth: 0 };

  if (launch) {
    const b = pump.buy(devSol, 50); m.sol -= devSol; m.tokPump += b.tokens; m.escrowSol += b.tax;
    let ethIn = seedEth;
    if (!rule.seedPons) { // parity sizing: only what lifts Pons to the pump.fun landing
      const targetPrice = pump.fdv(SOL_USD) / SUPPLY / ETH_USD;
      ethIn = Math.max(0, Math.min(frontEth - CFG.makerCashEth, (Math.sqrt(PONS_K * targetPrice) - pons.q) / (1 - 0.03)));
    }
    if (ethIn > 0) { const pb = pons.buy(ethIn); m.eth -= ethIn; m.tokPons += pb.tokens; m.escrowEth += pb.tax; }
    // a first wave of outside buyers so there is something to dump later
    const w = pump.buy(2); m.escrowSol += w.tax; const pw = pons.buy(0.1); m.escrowEth += pw.tax;
    var out = { tokPump: w.tokens, tokPons: pw.tokens };
  } else {
    // the coin got here: opening bags valued at launch prices, harvest already repaid the front out of the bag
    // every rule (hold included) starts from the SAME bags here, so cells compare behaviour, not bag size
    const launchFdv = 4230; // pump.fun landing of the production dev buy
    const bagPumpUsd = CFG.devBuySol * SOL_USD * (fdv / launchFdv), bagPonsUsd = (CFG.frontEth - CFG.makerCashEth) * ETH_USD * (fdv / launchFdv);
    m.tokPump = Math.max(0, bagPumpUsd - frontSol * SOL_USD) / (pump.price() * SOL_USD);
    m.tokPons = Math.max(0, bagPonsUsd - frontEth * ETH_USD) / (pons.price() * ETH_USD);
    repaid.sol = frontSol; repaid.eth = frontEth;
    m.sol = rule.symmetric ? frontSol - 0.13 - devSol : 0.13;
    m.eth = rule.symmetric ? frontEth - CFG.makerCashEth - seedEth : CFG.makerCashEth;
    var out = { tokPump: Math.max(0, circulating(pump, true) - m.tokPump - CFG.lockPct * SUPPLY), tokPons: Math.max(0, circulating(pons, false) - m.tokPons - CFG.lockPct * SUPPLY) };
  }
  const entryPump = pump.price(), entryPons = pons.price();

  // clip sizing
  const depthUsd = Math.min(pump.q * SOL_USD, pons.q * ETH_USD);
  const clipUsd = rule.scaled ? Math.max(CFG.clipUsd, 0.005 * depthUsd) : CFG.clipUsd;
  const topupSol = rule.scaled ? Math.max(CFG.topupSol, (4 * clipUsd) / SOL_USD) : CFG.topupSol;
  const topupEth = rule.scaled ? Math.max(CFG.topupEth, (4 * clipUsd) / ETH_USD) : CFG.topupEth;
  const maxTopupSol = rule.scaled ? 6 * topupSol : CFG.maxTopupSol, maxTopupEth = rule.scaled ? 6 * topupEth : CFG.maxTopupEth;
  const keepClips = rule.reserveClips || CFG.keepClips;
  const keepSol = CFG.minSol + (keepClips * clipUsd) / SOL_USD, keepEth = CFG.minEth + (keepClips * clipUsd) / ETH_USD;
  const ceilUsd = rule.ceilClips * clipUsd;
  const bought = { pumpUsd: 0, ponsUsd: 0 };
  if (rule.reserveClips) { // the coin's own peg cash, fronted once at launch and never topped up
    const rs = (rule.reserveClips * clipUsd) / SOL_USD, re = (rule.reserveClips * clipUsd) / ETH_USD;
    m.sol += rs; m.eth += re; fronted.sol += rs; fronted.eth += re;
  }
  let soldUsd = 0, outsideBuyUsd = 0, burnedUsd = 0;
  const pend = { sol: 0, eth: 0 };
  const lastHarvest = { pump: -Infinity, pons: -Infinity };

  // outside flow: sells drain a share of holdings, buys spend a share of starting depth; 5% of ticks each
  const P = 0.05, events = P * TICKS;
  const sellFrac = (share: number) => (share > 0 ? 1 - Math.pow(1 - share, 1 / events) : 0);
  const fPump = sellFrac(sc.dumpPump), fPons = sellFrac(sc.dumpPons);
  const buySol = (sc.buyPump * pump.q) / events, buyEth = (sc.buyPons * pons.q) / events;

  const startValue = m.sol * SOL_USD + m.eth * ETH_USD + m.tokPump * pump.price() * SOL_USD + m.tokPons * pons.price() * ETH_USD;
  let trades = 0, gapSum = 0, inBand = 0, halted = false;

  for (let tick = 0; tick < TICKS; tick++) {
    if (buySol && r() < P) { const q = buySol * (0.5 + r()); const x = pump.buy(q); out.tokPump += x.tokens; m.escrowSol += x.tax; outsideBuyUsd += q * SOL_USD; }
    if (fPump && r() < P && out.tokPump > 0) { const t = out.tokPump * Math.min(1, fPump * (0.5 + r())); out.tokPump -= t; m.escrowSol += pump.sell(t).tax; }
    if (buyEth && r() < P) { const q = buyEth * (0.5 + r()); const x = pons.buy(q); out.tokPons += x.tokens; m.escrowEth += x.tax; outsideBuyUsd += q * ETH_USD; }
    if (fPons && r() < P && out.tokPons > 0) { const t = out.tokPons * Math.min(1, fPons * (0.5 + r())); out.tokPons -= t; const x = pons.sell(t); m.escrowEth += x.tax; }
    if (tick % 20 === 0) { // fee claims once a minute: `buyback` of each claim is earmarked for a buyback on its own chain, the rest is cash
      if (m.escrowEth >= 0.002) { const c = m.escrowEth; m.escrowEth = 0; pend.eth += rule.buyback * c; m.eth += c - rule.buyback * c; }
      if (m.escrowSol >= 0.01) { const c = m.escrowSol; m.escrowSol = 0; pend.sol += rule.buyback * c; m.sol += c - rule.buyback * c; }
    }

    const fp = pump.fdv(SOL_USD), fo = pons.fdv(ETH_USD);
    const gap = Math.abs(fp - fo) / Math.min(fp, fo);
    gapSum += gap; if (gap <= CFG.band) inBand++;
    // buy back and burn: only on a chain that is not the expensive side, so the burn never widens the gap
    if (pend.eth > 0 && fo <= fp * (1 + CFG.band)) { const x = pons.buy(pend.eth); m.escrowEth += x.tax; burnedUsd += pend.eth * ETH_USD; pend.eth = 0; }
    if (pend.sol > 0 && fp <= fo * (1 + CFG.band)) { const x = pump.buy(pend.sol, 50); m.escrowSol += x.tax; burnedUsd += pend.sol * SOL_USD; pend.sol = 0; }
    if (process.env.TRACE && tick % 300 === 0) console.log(`  ${rule.name} t${tick} gap ${(gap * 100).toFixed(1)}% fdv ${fp.toFixed(0)}/${fo.toFixed(0)} cash ${m.sol.toFixed(2)} SOL ${m.eth.toFixed(3)} ETH bag ${(m.tokPump / 1e6).toFixed(1)}M/${(m.tokPons / 1e6).toFixed(1)}M topups ${topups.sol}/${topups.eth}`);
    if (!rule.on || halted) continue;

    const held = m.sol * SOL_USD + m.eth * ETH_USD + pump.quoteFor(m.tokPump) * SOL_USD + pons.quoteFor(m.tokPons) * ETH_USD;
    const frontedUsd = (fronted.sol + topups.sol) * SOL_USD + (fronted.eth + topups.eth) * ETH_USD;
    const back = repaid.sol * SOL_USD + repaid.eth * ETH_USD;
    if (frontedUsd - held - back > CFG.maxLossUsd) { halted = true; continue; }

    if (gap > CFG.band) {
      const usd = clipUsd * Math.min(3, gap / CFG.band);
      if (fp > fo) {
        const can = Math.min(pump.tokensFor(usd / SOL_USD), m.tokPump);
        if (can >= pump.tokensFor(clipUsd / SOL_USD) / 4) { const x = pump.sell(can, 50); m.tokPump -= can; m.sol += x.quote; m.escrowSol += x.tax; soldUsd += x.quote * SOL_USD; bought.pumpUsd = Math.max(0, bought.pumpUsd - x.quote * SOL_USD); trades++; }
        const ok = bought.ponsUsd + usd <= ceilUsd;
        let eth = usd / ETH_USD;
        if (ok && !rule.symmetric && !rule.noTopup && m.eth - eth < CFG.minEth && canTopUp(fronted.eth + topups.eth, repaid.eth, topups.eth, topupEth, maxTopupEth)) { topups.eth += topupEth; m.eth += topupEth; }
        eth = Math.min(eth, m.eth - CFG.minEth);
        if (ok && eth > usd / ETH_USD / 4) { const x = pons.buy(eth); m.eth -= eth; m.tokPons += x.tokens; m.escrowEth += x.tax; bought.ponsUsd += eth * ETH_USD; trades++; }
      } else {
        const can = Math.min(pons.tokensFor(usd / ETH_USD), m.tokPons);
        if (can >= pons.tokensFor(clipUsd / ETH_USD) / 4) { const x = pons.sell(can); m.tokPons -= can; m.eth += x.quote; m.escrowEth += x.tax; soldUsd += x.quote * ETH_USD; bought.ponsUsd = Math.max(0, bought.ponsUsd - x.quote * ETH_USD); trades++; }
        const ok = bought.pumpUsd + usd <= ceilUsd;
        let sol = usd / SOL_USD;
        if (ok && !rule.symmetric && !rule.noTopup && m.sol - sol < CFG.minSol && canTopUp(fronted.sol + topups.sol, repaid.sol, topups.sol, topupSol, maxTopupSol)) { topups.sol += topupSol; m.sol += topupSol; }
        sol = Math.min(sol, m.sol - CFG.minSol);
        if (ok && sol > usd / SOL_USD / 4) { const x = pump.buy(sol, 50); m.sol -= sol; m.tokPump += x.tokens; m.escrowSol += x.tax; bought.pumpUsd += sol * SOL_USD; trades++; }
      }
    } else {
      if (repaid.sol < fronted.sol && pump.price() >= entryPump * (1 + rule.margin) && m.tokPump > 0 && tick - lastHarvest.pump >= rule.harvestEvery) {
        const can = Math.min(pump.tokensFor(clipUsd / SOL_USD), m.tokPump); const x = pump.sell(can, 50); m.tokPump -= can; m.sol += x.quote; m.escrowSol += x.tax; soldUsd += x.quote * SOL_USD; trades++; lastHarvest.pump = tick;
      }
      if (repaid.eth < fronted.eth && pons.price() >= entryPons * (1 + rule.margin) && m.tokPons > 0 && tick - lastHarvest.pons >= rule.harvestEvery) {
        const can = Math.min(pons.tokensFor(clipUsd / ETH_USD), m.tokPons); const x = pons.sell(can); m.tokPons -= can; m.eth += x.quote; m.escrowEth += x.tax; soldUsd += x.quote * ETH_USD; trades++; lastHarvest.pons = tick;
      }
    }
    if (m.sol > keepSol) { repaid.sol += m.sol - keepSol; m.sol = keepSol; }
    if (m.eth > keepEth) { repaid.eth += m.eth - keepEth; m.eth = keepEth; }
  }

  // mark to market at the end: the same yardstick for every rule, including hold
  const endValue = (m.sol + m.escrowSol + pend.sol + repaid.sol - (launch ? 0 : frontSol)) * SOL_USD + (m.eth + m.escrowEth + pend.eth + repaid.eth - (launch ? 0 : frontEth)) * ETH_USD
    + m.tokPump * pump.price() * SOL_USD + m.tokPons * pons.price() * ETH_USD;
  const topupsUsd = topups.sol * SOL_USD + topups.eth * ETH_USD;
  if (process.env.DEBUG) console.log(`  [${rule.name}] start ${startValue.toFixed(0)} end ${endValue.toFixed(0)} | cash ${(m.sol * SOL_USD).toFixed(0)}/${(m.eth * ETH_USD).toFixed(0)} repaid ${(repaid.sol * SOL_USD).toFixed(0)}/${(repaid.eth * ETH_USD).toFixed(0)} escrow ${(m.escrowSol * SOL_USD).toFixed(0)}/${(m.escrowEth * ETH_USD).toFixed(0)} tok $${(m.tokPump * pump.price() * SOL_USD).toFixed(0)}/${(m.tokPons * pons.price() * ETH_USD).toFixed(0)} (${(m.tokPump / 1e6).toFixed(1)}M/${(m.tokPons / 1e6).toFixed(1)}M) fdv ${pump.fdv(SOL_USD).toFixed(0)}/${pons.fdv(ETH_USD).toFixed(0)} sold ${soldUsd.toFixed(0)} topups ${topupsUsd.toFixed(0)} trades ${trades}`);
  return { valueDelta: endValue - startValue - topupsUsd, topupsUsd, inBand: inBand / TICKS, avgGap: gapSum / TICKS, trades, halted, soldUsd, outsideBuyUsd, burnedUsd, repaidUsd: repaid.sol * SOL_USD + repaid.eth * ETH_USD };
}

// ---- main ---------------------------------------------------------------------------------------------------------
const argFdv = process.argv[2] !== undefined ? Number(process.argv[2]) : undefined;
const argSc = process.argv[3];
const SEEDS = Number(process.env.SEEDS ?? 20);
const FDVS = argFdv !== undefined ? [argFdv] : [0, 25_000, 100_000, 500_000, 1_000_000, 5_000_000];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const money = (n: number) => (Math.abs(n) >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0));

console.log(`3h at ${TICK_S}s, ${SEEDS} seeds. Graduation FDV: pump.fun $${money(PUMP_GRAD_FDV)}, Pons $${money(PONS_GRAD_FDV)}. SOL $${SOL_USD}, ETH $${ETH_USD}.`);
console.log(`Cells: edge over HOLD in $ (value change minus top-ups) / % of ticks inside the 5% band. Front $${money(CFG.frontSol * SOL_USD + CFG.frontEth * ETH_USD)} per coin (dev buy ${CFG.devBuySol} SOL, ETH seed ${Number.isNaN(CFG.seedEth) ? "front" : CFG.seedEth}), lock ${(CFG.lockPct * 100).toFixed(0)}%, clip $${CFG.clipUsd}.`);
for (const fdv of FDVS) {
  const pv = fdv ? pumpAt(fdv) : freshPump(), ov = fdv ? ponsAt(fdv) : freshPons();
  const shallow = Math.min(pv.q * SOL_USD, ov.q * ETH_USD);
  console.log(`\n### FDV ${fdv ? "$" + money(fdv) : "fresh launch (~$4.2k)"} — pump ${pv.label} $${money(pv.q * SOL_USD)} deep, Pons ${ov.label} $${money(ov.q * ETH_USD)} deep; closing a 10% gap takes ~$${money(0.049 * shallow)} on the shallow side (${Math.ceil(0.049 * shallow / CFG.clipUsd)} clips)`);
  console.log(`${"scenario".padEnd(12)}${"dump".padStart(5)} | ` + RULES.filter((x) => x.on).map((x) => x.name.padStart(process.env.SOLD ? 32 : 14)).join(" ") + "   hold Δ$");
  for (const intensity of [0.3, 0.7]) {
    for (const sc of scenarios(intensity)) {
      if (argSc && sc.name !== argSc) continue;
      const seeds = Array.from({ length: SEEDS }, (_, i) => 1000 + i);
      const hold = seeds.map((s) => run(fdv, sc, RULES[0], s));
      const cells = RULES.filter((x) => x.on).map((rule) => {
        const rs = seeds.map((s) => run(fdv, sc, rule, s));
        const edge = mean(rs.map((x, i) => x.valueDelta - hold[i].valueDelta));
        const ib = mean(rs.map((x) => x.inBand * 100));
        const h = rs.filter((x) => x.halted).length;
        const sold = mean(rs.map((x) => x.soldUsd)), tu = mean(rs.map((x) => x.topupsUsd)), bb = mean(rs.map((x) => x.burnedUsd));
        const extra = process.env.SOLD ? ` s${money(sold).padStart(5)} t${money(tu).padStart(4)} b${money(bb).padStart(4)}` : "";
        return `${money(edge).padStart(7)}/${ib.toFixed(0).padStart(3)}%${h ? "!" : " "}${extra}`.padStart(process.env.SOLD ? 32 : 14);
      });
      console.log(`${sc.name.padEnd(12)}${(intensity * 100).toFixed(0).padStart(4)}% | ${cells.join(" ")}   ${money(mean(hold.map((x) => x.valueDelta)))}`);
    }
  }
}
console.log("\n'!' = the $150 loss guard halted the maker in at least one seed. hold Δ$ = what the opening bag gained or lost with the maker off.");
