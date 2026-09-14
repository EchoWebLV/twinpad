import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { PONS, TOKEN_SUPPLY } from "./pons.js";

/**
 * Uniswap v4 pool for a graduated Pons launch. Pool key per the Pons docs:
 * currencies sorted by address (native ETH = 0x0 is always currency0), fee 0,
 * tickSpacing from the launch record, hooks = the shared meme hook.
 * Verified: TWINE's id 0x9ee0e829… resolves to a populated slot0 on the PoolManager.
 */
export function poolKey(token: Address, tickSpacing: number, pairToken: Address = PONS.ZERO) {
  const [currency0, currency1] =
    pairToken.toLowerCase() < token.toLowerCase() ? [pairToken, token] : [token, pairToken];
  return { currency0, currency1, fee: 0, tickSpacing, hooks: PONS.memeHook };
}

export function poolId(key: ReturnType<typeof poolKey>): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

const pmAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
const POOLS_SLOT = 6n; // PoolManager: mapping(PoolId => Pool.State) internal _pools at slot 6

export interface V4Slot0 {
  sqrtPriceX96: bigint;
  tick: number;
  initialized: boolean;
  /** ETH per token, when token is currency1 and ETH currency0 */
  price: number;
  fdvEth: number;
}

export async function readSlot0(client: PublicClient, key: ReturnType<typeof poolKey>): Promise<V4Slot0> {
  const id = poolId(key);
  const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, POOLS_SLOT]));
  const raw = await client.readContract({ address: PONS.poolManager, abi: pmAbi, functionName: "extsload", args: [slot] });
  const v = BigInt(raw);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  let tick = Number((v >> 160n) & ((1n << 24n) - 1n));
  if (tick > 0x7fffff) tick -= 0x1000000;
  const p = Number(sqrtPriceX96) / 2 ** 96;
  const price1per0 = p * p; // currency1 per currency0
  const tokenIsCurrency1 = key.currency1.toLowerCase() !== PONS.ZERO;
  const price = sqrtPriceX96 === 0n ? 0 : tokenIsCurrency1 ? 1 / price1per0 : price1per0;
  return { sqrtPriceX96, tick, initialized: sqrtPriceX96 !== 0n, price, fdvEth: price * TOKEN_SUPPLY };
}

/** Active liquidity L (Pool.State slot +3). Verified on TWINE: L/√P ≈ 37.6 ETH vs the 42 ETH twine.auction showed as "quote in pool". */
export async function readLiquidity(client: PublicClient, key: ReturnType<typeof poolKey>): Promise<bigint> {
  const id = poolId(key);
  const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, POOLS_SLOT])));
  const slot = ("0x" + (base + 3n).toString(16).padStart(64, "0")) as Hex;
  const raw = await client.readContract({ address: PONS.poolManager, abi: pmAbi, functionName: "extsload", args: [slot] });
  return BigInt(raw) & ((1n << 128n) - 1n);
}

/** Approximate quote-side depth of the pool in ETH (L / √P), for display like twine's quoteDepth. */
export function ethDepth(liquidity: bigint, slot0: V4Slot0): number {
  if (slot0.sqrtPriceX96 === 0n) return 0;
  return Number(liquidity) / (Number(slot0.sqrtPriceX96) / 2 ** 96) / 1e18;
}

// ---- swapping through the UniversalRouter (execute) ----
// Commands / actions per Uniswap's universal-router and v4-periphery libraries.
const CMD_V4_SWAP = 0x10;
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE_ALL = 0x0f;

export const universalRouterAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);
export const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

const poolKeyType = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

/**
 * Encode a single-hop exact-input swap. `zeroForOne` true = pay currency0 (ETH) get currency1 (token).
 * Returns calldata + msg.value for `universalRouter.execute`.
 */
export function encodeV4ExactInSingle(
  key: ReturnType<typeof poolKey>,
  zeroForOne: boolean,
  amountIn: bigint,
  amountOutMin: bigint,
  deadlineSec: number,
) {
  const actions = ("0x" +
    [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL].map((b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
  const swapParams = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          poolKeyType as any,
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [[key, zeroForOne, amountIn, amountOutMin, "0x"] as any],
  );
  const currencyIn = zeroForOne ? key.currency0 : key.currency1;
  const currencyOut = zeroForOne ? key.currency1 : key.currency0;
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currencyIn, amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currencyOut, amountOutMin]);
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swapParams, settle, take]]);
  const commands = ("0x" + CMD_V4_SWAP.toString(16).padStart(2, "0")) as Hex;
  const data = encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [commands, [input], BigInt(deadlineSec)],
  });
  const value = currencyIn.toLowerCase() === PONS.ZERO ? amountIn : 0n;
  return { to: PONS.universalRouter, data, value };
}
