#!/usr/bin/env tsx
/**
 * Seed a Uniswap v4 ETH/LSTP pool on Robinhood Chain at the current pump.fun price.
 *
 *   pnpm seed -- --lstp 50000              dry run: price, pool key, amounts, calldata, simulation
 *   pnpm seed -- --lstp 50000 --confirm    approve (Permit2), initialize the pool, mint the liquidity
 *
 * Two shapes: --lstp <whole tokens> mints a ONE-SIDED position (LSTP only, zero ETH beyond gas) from the current price upward,
 * so the pool only sells LSTP as buyers push the price up; --eth <eth> mints a balanced full-range position (ETH + matching LSTP).
 * Options (env or flags): --rpc URL, --token 0x.., --fee 10000, --price-eth <eth per token>, --swap-test <eth> (buy via UniversalRouter, spends),
 * --mint <solana mint> (pump.fun price source), --key-file path (evm deployer json from `cast wallet new --json`).
 * Nothing is sent without --confirm.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient, createWalletClient, http, parseEther, formatEther, formatUnits,
  encodeFunctionData, encodeAbiParameters, keccak256, parseAbi, type Address, type Hex, defineChain, zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { TickMath, maxLiquidityForAmounts, SqrtPriceMath } from '@uniswap/v3-sdk'
import JSBI from 'jsbi'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? 'true' : process.argv[++i])
}
const opt = (k: string, d?: string) => args.get(k) ?? process.env[k.toUpperCase().replace(/-/g, '_')] ?? d
const CONFIRM = args.get('confirm') === 'true'

// Robinhood Chain mainnet, Uniswap v4 (developers.uniswap.org/contracts/v4/deployments)
export const V4 = {
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
} as const satisfies Record<string, Address>

const robinhood = defineChain({
  id: Number(opt('chain-id', '4663')),
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [opt('rpc', 'https://rpc.mainnet.chain.robinhood.com')!] } },
})

const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])
const permit2Abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
])
const posmAbi = parseAbi([
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function initializePool((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, uint160 sqrtPriceX96) payable returns (int24)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  'function nextTokenId() view returns (uint256)',
])
const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
  'function getTickLiquidity(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)',
])
const quoterAbi = parseAbi([
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
])

const routerAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
])
// v4-periphery Actions.sol ; UniversalRouter Commands.sol V4_SWAP = 0x10
const Actions = { MINT_POSITION: 0x02, SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, SETTLE_PAIR: 0x0d, TAKE_ALL: 0x0f, SWEEP: 0x14 } as const
const V4_SWAP_COMMAND = '0x10' as Hex
const poolKeyType = { type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] } as const

type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
const TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 }

export function poolId(k: PoolKey): Hex {
  return keccak256(encodeAbiParameters([poolKeyType], [k]))
}
export function sqrtPriceX96FromTokensPerEth(tokensPerEth: number): bigint {
  // both currencies 18 decimals: price = raw1/raw0 = tokensPerEth. sqrtPriceX96 = sqrt(price) * 2^96
  const scaled = BigInt(Math.round(tokensPerEth * 1e12)) // 12 dp of precision
  const x = (scaled << 192n) / 10n ** 12n
  return isqrt(x)
}
export function isqrt(n: bigint): bigint {
  if (n < 2n) return n
  let x = BigInt(Math.floor(Math.sqrt(Number(n)))) || 1n
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) { if (x * x > n) x -= 1n; while ((x + 1n) * (x + 1n) <= n) x += 1n; return x } x = y }
}
const J = (b: bigint) => JSBI.BigInt(b.toString())
const B = (j: JSBI) => BigInt(j.toString())

export function fullRangeTicks(tickSpacing: number) {
  const lo = Math.ceil(TickMath.MIN_TICK / tickSpacing) * tickSpacing
  const hi = Math.floor(TickMath.MAX_TICK / tickSpacing) * tickSpacing
  return { tickLower: lo, tickUpper: hi }
}
export function lstpOnlyTicks(curTick: number, tickSpacing: number) {
  // LSTP is currency1: a range entirely at or below the current tick holds only LSTP, and ETH buys (price of LSTP rising,
  // tick falling) walk down into it. tickUpper is the current tick rounded down to the spacing.
  const tickLower = Math.ceil(TickMath.MIN_TICK / tickSpacing) * tickSpacing
  const tickUpper = Math.floor(curTick / tickSpacing) * tickSpacing
  if (tickUpper <= tickLower) throw new Error(`price too low for a one-sided range (tick ${curTick})`)
  return { tickLower, tickUpper }
}
export function liquidityAndAmounts(sqrtP: bigint, tickLower: number, tickUpper: number, ethWei: bigint, tokenWei: bigint) {
  const sa = TickMath.getSqrtRatioAtTick(tickLower), sb = TickMath.getSqrtRatioAtTick(tickUpper), p = J(sqrtP)
  const L = maxLiquidityForAmounts(p, sa, sb, J(ethWei), J(tokenWei), true)
  // what the mint pulls at the current price: only ETH above the range, only LSTP at or below it, both inside (Pool.modifyLiquidity)
  const below = JSBI.greaterThanOrEqual(p, sb), above = JSBI.lessThanOrEqual(p, sa)
  const amount0 = below ? 0n : B(SqrtPriceMath.getAmount0Delta(above ? sa : p, sb, L, true))
  const amount1 = above ? 0n : B(SqrtPriceMath.getAmount1Delta(sa, below ? sb : p, L, true))
  return { liquidity: B(L), amount0, amount1 }
}
export function encodeMint(key: PoolKey, tickLower: number, tickUpper: number, liquidity: bigint, amount0Max: bigint, amount1Max: bigint, owner: Address, deadline: bigint): Hex {
  const actions = ('0x' + [Actions.MINT_POSITION, Actions.SETTLE_PAIR, Actions.SWEEP].map((a) => a.toString(16).padStart(2, '0')).join('')) as Hex
  const params: Hex[] = [
    encodeAbiParameters(
      [poolKeyType, { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' }],
      [key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, '0x'],
    ),
    encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [key.currency0, key.currency1]),
    encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [key.currency0, owner]),
  ]
  const unlockData = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, params])
  return encodeFunctionData({ abi: posmAbi, functionName: 'modifyLiquidities', args: [unlockData, deadline] })
}

export function encodeSwapEthForToken(key: PoolKey, amountIn: bigint, minOut: bigint, deadline: bigint): Hex {
  const actions = ('0x' + [Actions.SWAP_EXACT_IN_SINGLE, Actions.SETTLE_ALL, Actions.TAKE_ALL].map((a) => a.toString(16).padStart(2, '0')).join('')) as Hex
  const params: Hex[] = [
    encodeAbiParameters(
      [{ type: 'tuple', components: [
        { name: 'poolKey', ...poolKeyType }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' },
        { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' },
      ] }],
      [{ poolKey: key, zeroForOne: true, amountIn, amountOutMinimum: minOut, hookData: '0x' }],
    ),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key.currency0, amountIn]),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key.currency1, minOut]),
  ]
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, params])
  return encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: [V4_SWAP_COMMAND, [input], deadline] })
}

async function pumpfunPriceSolPerToken(mint: string): Promise<number> {
  const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, { headers: { 'user-agent': 'twinpad-oft-poc' } })
  if (!r.ok) throw new Error(`pump.fun coin api ${r.status}`)
  const c = (await r.json()) as { virtual_sol_reserves: number; virtual_token_reserves: number }
  return (c.virtual_sol_reserves / 1e9) / (c.virtual_token_reserves / 1e6)
}
async function solPerEth(): Promise<number> {
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum&vs_currencies=usd', { headers: { 'user-agent': 'twinpad-oft-poc' } })
  if (!r.ok) throw new Error(`coingecko ${r.status}`)
  const j = (await r.json()) as { solana: { usd: number }; ethereum: { usd: number } }
  return j.ethereum.usd / j.solana.usd
}

function loadDeployerKey(): Hex {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY as Hex
  const f = resolve(HERE, opt('key-file', '../.keys/evm-deployer.json')!)
  const j = JSON.parse(readFileSync(f, 'utf8'))
  return (Array.isArray(j) ? j[0].private_key : j.private_key) as Hex
}
function defaultTokenAddress(): Address | undefined {
  for (const f of ['../lz/deployments/robinhood-mainnet/LockstepOFT.json', '../lz/deployments/robinhood-testnet/LockstepOFT.json']) {
    const p = resolve(HERE, f)
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).address as Address
  }
}

async function main() {
  const account = privateKeyToAccount(loadDeployerKey())
  const pub = createPublicClient({ chain: robinhood, transport: http() })
  const wallet = createWalletClient({ chain: robinhood, transport: http(), account })
  const token = (opt('token') ?? defaultTokenAddress()) as Address | undefined
  if (!token) throw new Error('no token: pass --token 0x.. or deploy LockstepOFT first')
  const fee = Number(opt('fee', '10000'))
  const tickSpacing = TICK_SPACING[fee]
  if (!tickSpacing) throw new Error(`unsupported fee ${fee}`)
  const ethIn = parseEther(opt('eth', '0.01')!)
  const lstpOnly = opt('lstp') !== undefined // one-sided: LSTP only, no ETH beyond gas
  if (lstpOnly && !(Number(opt('lstp')) > 0)) throw new Error('--lstp needs a positive amount in whole tokens')
  const lstpIn = lstpOnly ? BigInt(Math.round(Number(opt('lstp')) * 1e6)) * 10n ** 12n : 0n // 18 dp

  let ethPerToken: number
  if (opt('price-eth')) ethPerToken = Number(opt('price-eth'))
  else {
    const mint = opt('mint')
    if (!mint) throw new Error('need --price-eth or --mint <pump.fun mint> for the price')
    const [solPerTok, solEth] = await Promise.all([pumpfunPriceSolPerToken(mint), solPerEth()])
    ethPerToken = solPerTok / solEth
    console.log(`pump.fun price ${solPerTok.toExponential(4)} SOL/token, ${solEth.toFixed(2)} SOL per ETH`)
  }
  const tokensPerEth = 1 / ethPerToken
  const key: PoolKey = { currency0: zeroAddress, currency1: token, fee, tickSpacing, hooks: zeroAddress }
  const id = poolId(key)
  const sqrtMarket = sqrtPriceX96FromTokensPerEth(tokensPerEth)

  const [decimals, symbol, ethBal, tokBal, slot0] = await Promise.all([
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    pub.getBalance({ address: account.address }),
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
    pub.readContract({ address: V4.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [id] }),
  ])
  if (decimals !== 18) throw new Error(`token decimals ${decimals} != 18; price math assumes 18`)
  const initialized = slot0[0] !== 0n

  // Amounts are computed at the price the mint will see: the live pool price if it exists, else the price we initialize at.
  let tickLower: number, tickUpper: number, sqrtInit = sqrtMarket
  if (lstpOnly) {
    const marketTick = initialized ? slot0[1] : TickMath.getTickAtSqrtRatio(J(sqrtMarket))
    ;({ tickLower, tickUpper } = lstpOnlyTicks(marketTick, tickSpacing))
    // a fresh pool starts exactly at the top of the wall (at most one tick spacing under market) so the first buy meets liquidity
    if (!initialized) sqrtInit = B(TickMath.getSqrtRatioAtTick(tickUpper))
  } else {
    ;({ tickLower, tickUpper } = fullRangeTicks(tickSpacing))
  }
  const sqrtP = initialized ? slot0[0] : sqrtInit
  const tokenWanted = lstpOnly ? lstpIn : BigInt(Math.round(Number(formatEther(ethIn)) * tokensPerEth * 1e6)) * 10n ** 12n // 18 dp
  const { liquidity, amount0, amount1 } = liquidityAndAmounts(sqrtP, tickLower, tickUpper, lstpOnly ? 0n : ethIn, tokenWanted)
  const slack = (a: bigint) => (a === 0n ? 0n : a + a / 100n + 1n) // 1% headroom, none for a side we do not fund
  const amount0Max = slack(amount0), amount1Max = slack(amount1)
  console.log(`deployer   ${account.address}  ETH ${formatEther(ethBal)}  ${symbol} ${formatUnits(tokBal, 18)}`)
  console.log(`token      ${token} (${symbol})`)
  console.log(`pool       fee ${fee / 1e4}% tickSpacing ${tickSpacing} id ${id}`)
  console.log(`mode       ${opt('swap-test') ? 'swap test only, nothing is minted' : lstpOnly ? `one-sided, ${formatUnits(lstpIn, 18)} ${symbol} only, ticks ${tickLower}..${tickUpper} (sells ${symbol} from the current price upward, no ETH)` : `balanced full range, ${formatEther(ethIn)} ETH + matching ${symbol}`}`)
  console.log(`price      1 ETH = ${tokensPerEth.toFixed(2)} ${symbol}   (1 ${symbol} = ${ethPerToken.toExponential(4)} ETH)   sqrtPriceX96 ${sqrtMarket}${sqrtInit !== sqrtMarket ? `, pool starts at ${sqrtInit} (tick ${tickUpper})` : ''}`)
  console.log(`liquidity  L=${liquidity}  ETH ${formatEther(amount0)} (max ${formatEther(amount0Max)})  ${symbol} ${formatUnits(amount1, 18)} (max ${formatUnits(amount1Max, 18)})`)
  console.log(`state      ${initialized ? `already initialized at sqrtPriceX96 ${slot0[0]} tick ${slot0[1]}` : 'not initialized'}`)

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800)

  if (opt('swap-test')) {
    // Buy with ETH through the UniversalRouter, the same path trading bots and the Uniswap UI use. Spends ETH.
    if (!initialized) throw new Error('pool not initialized; seed it first')
    const amountIn = parseEther(opt('swap-test')!)
    const q = await pub.simulateContract({ address: V4.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne: true, exactAmount: amountIn, hookData: '0x' }] })
    const minOut = q.result[0] - q.result[0] / 50n // 2% slippage
    const data = encodeSwapEthForToken(key, amountIn, minOut, deadline)
    const before = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
    const hash = await wallet.sendTransaction({ to: V4.universalRouter, data, value: amountIn })
    const rcpt = await pub.waitForTransactionReceipt({ hash })
    const after = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
    console.log(`swap       ${formatEther(amountIn)} ETH -> ${formatUnits(after - before, 18)} ${symbol} (quoted ${formatUnits(q.result[0], 18)}) tx ${hash} status ${rcpt.status}`)
    if (rcpt.status !== 'success' || after <= before) throw new Error('swap failed')
    return
  }

  const calls: Hex[] = []
  if (!initialized) calls.push(encodeFunctionData({ abi: posmAbi, functionName: 'initializePool', args: [key, sqrtInit] }))
  calls.push(encodeMint(key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, account.address, deadline))
  const multicall = encodeFunctionData({ abi: posmAbi, functionName: 'multicall', args: [calls] })
  console.log(`calldata   multicall ${calls.length} calls, ${multicall.length / 2 - 1} bytes, value ${formatEther(amount0Max)} ETH`)

  if (ethBal < amount0Max + parseEther('0.001')) console.log(`!! deployer needs ${formatEther(amount0Max + parseEther('0.001'))} ETH`)
  if (tokBal < amount1Max) console.log(`!! deployer needs ${formatUnits(amount1Max, 18)} ${symbol} (bridge them from Solana first)`)

  if (!CONFIRM) {
    try {
      const gas = await pub.estimateGas({ account: account.address, to: V4.positionManager, data: multicall, value: amount0Max })
      console.log(`simulate   ok, gas ${gas} (approvals assumed)`)
    } catch (e) {
      console.log(`simulate   reverted (expected until balances + approvals are in place): ${(e as Error).message.split('\n')[0]}`)
    }
    console.log('dry run only. To seed:  pnpm seed -- --confirm' + (opt('mint') ? ` --mint ${opt('mint')}` : ` --price-eth ${ethPerToken}`) + (lstpOnly ? ` --lstp ${opt('lstp')}` : ` --eth ${opt('eth', '0.01')}`))
    return
  }
  if (ethBal < amount0Max + parseEther('0.001') || tokBal < amount1Max) throw new Error('insufficient balances, see above')

  const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account.address, V4.permit2] })
  if (allowance < amount1Max) {
    const h = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [V4.permit2, 2n ** 256n - 1n] })
    await pub.waitForTransactionReceipt({ hash: h }); console.log(`approve    token -> Permit2 ${h}`)
  }
  const [p2amt, p2exp] = await pub.readContract({ address: V4.permit2, abi: permit2Abi, functionName: 'allowance', args: [account.address, token, V4.positionManager] })
  if (p2amt < amount1Max || p2exp < Number(deadline)) {
    const h = await wallet.writeContract({ address: V4.permit2, abi: permit2Abi, functionName: 'approve', args: [token, V4.positionManager, 2n ** 160n - 1n, Number(deadline) + 86400 * 30] })
    await pub.waitForTransactionReceipt({ hash: h }); console.log(`approve    Permit2 -> PositionManager ${h}`)
  }
  const gas = await pub.estimateGas({ account: account.address, to: V4.positionManager, data: multicall, value: amount0Max })
  const hash = await wallet.sendTransaction({ to: V4.positionManager, data: multicall, value: amount0Max, gas: gas + gas / 5n })
  const rcpt = await pub.waitForTransactionReceipt({ hash })
  console.log(`seeded     tx ${hash} status ${rcpt.status} gasUsed ${rcpt.gasUsed}`)

  const [s0, liq, wall] = await Promise.all([
    pub.readContract({ address: V4.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [id] }),
    pub.readContract({ address: V4.stateView, abi: stateViewAbi, functionName: 'getLiquidity', args: [id] }),
    pub.readContract({ address: V4.stateView, abi: stateViewAbi, functionName: 'getTickLiquidity', args: [id, tickUpper] }),
  ])
  // In the one-sided shape the position ends at tickUpper, at or just under the current tick, so the pool's ACTIVE liquidity
  // reads 0 until the first buy crosses down into it; the wall itself shows up as liquidityGross at tickUpper.
  console.log(`verify     sqrtPriceX96 ${s0[0]} tick ${s0[1]} lpFee ${s0[3]} active liquidity ${liq}${lstpOnly ? `, ${symbol} wall at tick ${tickUpper} liquidityGross ${wall[0]} (active once the first buy crosses into it)` : ''}`)
  const q = await pub.simulateContract({ address: V4.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne: true, exactAmount: parseEther('0.001'), hookData: '0x' }] })
  console.log(`quote      0.001 ETH -> ${formatUnits(q.result[0], 18)} ${symbol}`)
  console.log(`dexscreener https://dexscreener.com/robinhood/${id}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
