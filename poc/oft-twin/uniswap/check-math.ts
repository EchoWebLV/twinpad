// Pure-math checks for seed-pool.ts, no network: isqrt correctness (the float-seeded version spun for hours at some live
// prices) and the one-sided range math at the live pump.fun price of 2026-09-14. Run: pnpm check
import { isqrt, sqrtPriceX96FromTokensPerEth, lstpOnlyTicks, liquidityAndAmounts } from './seed-pool'
import { TickMath } from '@uniswap/v3-sdk'
import JSBI from 'jsbi'

function assert(cond: boolean, msg: string) { if (!cond) { console.error('FAIL', msg); process.exit(1) } }
const t0 = Date.now()
const rnd = (bits: number) => { let v = 0n; for (let i = 0; i < bits; i += 30) v = (v << 30n) | BigInt(Math.floor(Math.random() * 2 ** 30)); return v & ((1n << BigInt(bits)) - 1n) }
let checks = 0
for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, (1n << 192n) - 1n, 1n << 192n, (1n << 192n) + 1n]) { const r = isqrt(n); assert(r * r <= n && (r + 1n) * (r + 1n) > n, `isqrt(${n})`); checks++ }
for (let i = 0; i < 20000; i++) { const n = rnd(60 + (i % 200)); const r = isqrt(n); assert(r * r <= n && (r + 1n) * (r + 1n) > n, `isqrt(${n}) = ${r}`); checks++ }
for (let i = 0; i < 2000; i++) { const k = rnd(120); for (const n of [k * k, k * k - 1n, k * k + 1n]) { if (n < 0n) continue; const r = isqrt(n); assert(r * r <= n && (r + 1n) * (r + 1n) > n, `isqrt near square ${k}`); checks++ } }
// the price that hung the old code: solPerTok 3.672373340462687e-8, solEth 24.540427 -> 668,244,345 LSTP per ETH
const tokensPerEth = 1 / (3.672373340462687e-8 / 24.540427)
const sqrtMarket = sqrtPriceX96FromTokensPerEth(tokensPerEth)
assert(sqrtMarket * sqrtMarket <= (BigInt(Math.round(tokensPerEth * 1e12)) << 192n) / 10n ** 12n, 'sqrtMarket floor')
const tick = TickMath.getTickAtSqrtRatio(JSBI.BigInt(sqrtMarket.toString()))
assert(tick > 203000 && tick < 203400, `market tick ${tick}`)
const { tickLower, tickUpper } = lstpOnlyTicks(tick, 200)
assert(tickLower === -887200 && tickUpper === 203200, `ticks ${tickLower}..${tickUpper}`)
const sqrtInit = BigInt(TickMath.getSqrtRatioAtTick(tickUpper).toString())
const { liquidity, amount0, amount1 } = liquidityAndAmounts(sqrtInit, tickLower, tickUpper, 0n, 50000n * 10n ** 18n)
assert(amount0 === 0n, `one-sided amount0 ${amount0}`)
assert(amount1 > 49990n * 10n ** 18n && amount1 <= 50000n * 10n ** 18n, `amount1 ${amount1}`)
assert(liquidity > 0n, 'liquidity')
console.log(`check-math ok: ${checks} isqrt checks, live-price range ${tickLower}..${tickUpper}, amount1 ${amount1}, ${Date.now() - t0} ms`)
