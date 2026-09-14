import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { parseEther, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { sendSigned, tradeLocal, mintTokenProgram, pda } from "./solana/pump.js";
import { curveAbi, erc20Abi, quoteBuy, quoteSell, readLaunch, PONS } from "./evm/pons.js";
import { encodeV4ExactInSingle, permit2Abi, poolKey } from "./evm/v4.js";

export interface SolTradeOpts {
  slippagePct: number;
  priorityFeeSol: number;
}

/** Buy with SOL on pump.fun (curve or PumpSwap, PumpPortal picks with pool "auto"). */
export async function solanaBuy(conn: Connection, wallet: Keypair, mint: PublicKey, sol: number, o: SolTradeOpts) {
  const tx = await tradeLocal({
    publicKey: wallet.publicKey.toBase58(),
    action: "buy",
    mint: mint.toBase58(),
    denominatedInSol: "true",
    amount: sol,
    slippage: o.slippagePct,
    priorityFee: o.priorityFeeSol,
    pool: "auto",
  });
  tx.sign([wallet]);
  return sendSigned(conn, tx);
}

/** Sell a token amount (whole tokens) or "100%". */
export async function solanaSell(
  conn: Connection,
  wallet: Keypair,
  mint: PublicKey,
  tokens: number | "100%",
  o: SolTradeOpts,
) {
  const tx = await tradeLocal({
    publicKey: wallet.publicKey.toBase58(),
    action: "sell",
    mint: mint.toBase58(),
    denominatedInSol: "false",
    amount: tokens === "100%" ? "100%" : Math.floor(tokens),
    slippage: o.slippagePct,
    priorityFee: o.priorityFeeSol,
    pool: "auto",
  });
  tx.sign([wallet]);
  return sendSigned(conn, tx);
}

export async function solanaBalances(conn: Connection, owner: PublicKey, mint: PublicKey) {
  const sol = (await conn.getBalance(owner, "processed")) / 1e9;
  let tokens = 0;
  try {
    const prog = await mintTokenProgram(conn, mint);
    const ata = pda.ata(owner, mint, prog);
    const b = await conn.getTokenAccountBalance(ata, "processed");
    tokens = Number(b.value.uiAmountString ?? 0);
  } catch {
    tokens = 0; // no ATA yet
  }
  return { sol, tokens };
}

// ---------------- EVM ----------------

async function sendAndWait(pub: PublicClient, wallet: WalletClient, tx: { to: Address; data: Hex; value: bigint }) {
  const account = wallet.account!;
  const gas = await pub.estimateGas({ account, to: tx.to, data: tx.data, value: tx.value });
  const hash = await wallet.sendTransaction({ account, chain: wallet.chain, to: tx.to, data: tx.data, value: tx.value, gas: (gas * 12n) / 10n });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`tx ${hash} reverted`);
  return hash;
}

/** Buy on Pons: curve before graduation, Uniswap v4 via the UniversalRouter after. */
export async function evmBuy(pub: PublicClient, wallet: WalletClient, token: Address, eth: number, slippagePct: number) {
  const l = await readLaunch(pub, token);
  const me = wallet.account!.address;
  const quoteIn = parseEther(eth.toString());
  if (Number(l.phase) < 2) {
    const q = await quoteBuy(pub, l.curve, quoteIn, me);
    const minOut = (q.tokensOut * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n;
    const { encodeFunctionData } = await import("viem");
    const data = encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [quoteIn, minOut, me] });
    return sendAndWait(pub, wallet, { to: l.curve, data, value: quoteIn });
  }
  const key = poolKey(token, Number(l.tickSpacing), l.pairToken);
  const zeroForOne = key.currency0.toLowerCase() === PONS.ZERO; // ETH -> token
  const deadline = Math.floor(Date.now() / 1000) + 120;
  // minimum out from spot with slippage (hook takes its fee from the unspecified currency)
  const { readSlot0 } = await import("./evm/v4.js");
  const s = await readSlot0(pub, key);
  const expected = s.price > 0 ? Number(quoteIn) / 1e18 / s.price : 0;
  const minOut = BigInt(Math.floor(expected * (1 - slippagePct / 100) * 1e18));
  const tx = encodeV4ExactInSingle(key, zeroForOne, quoteIn, minOut, deadline);
  return sendAndWait(pub, wallet, tx);
}

/** Sell whole tokens on Pons (curve or v4). Handles Permit2 approvals for the router path. */
export async function evmSell(pub: PublicClient, wallet: WalletClient, token: Address, tokens: number, slippagePct: number) {
  const l = await readLaunch(pub, token);
  const me = wallet.account!.address;
  const tokensIn = parseEther(tokens.toFixed(6));
  const { encodeFunctionData } = await import("viem");
  if (Number(l.phase) < 2) {
    const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [me, l.curve] });
    if (allowance < tokensIn) {
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [l.curve, 2n ** 256n - 1n] });
      await sendAndWait(pub, wallet, { to: token, data, value: 0n });
    }
    const out = await quoteSell(pub, l.curve, tokensIn);
    const minOut = (out * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n;
    const data = encodeFunctionData({ abi: curveAbi, functionName: "sell", args: [tokensIn, minOut, me] });
    return sendAndWait(pub, wallet, { to: l.curve, data, value: 0n });
  }
  // v4 path: ERC20 -> Permit2 -> UniversalRouter
  const erc20Allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [me, PONS.permit2] });
  if (erc20Allowance < tokensIn) {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PONS.permit2, 2n ** 256n - 1n] });
    await sendAndWait(pub, wallet, { to: token, data, value: 0n });
  }
  const [p2Amount, p2Exp] = await pub.readContract({ address: PONS.permit2, abi: permit2Abi, functionName: "allowance", args: [me, token, PONS.universalRouter] });
  if (p2Amount < tokensIn || p2Exp < Math.floor(Date.now() / 1000) + 60) {
    const data = encodeFunctionData({
      abi: permit2Abi,
      functionName: "approve",
      args: [token, PONS.universalRouter, 2n ** 160n - 1n, Math.floor(Date.now() / 1000) + 30 * 24 * 3600],
    });
    await sendAndWait(pub, wallet, { to: PONS.permit2, data, value: 0n });
  }
  const key = poolKey(token, Number(l.tickSpacing), l.pairToken);
  const zeroForOne = key.currency0.toLowerCase() === token.toLowerCase(); // token -> ETH
  const { readSlot0 } = await import("./evm/v4.js");
  const s = await readSlot0(pub, key);
  const expectedEth = tokens * s.price;
  const minOut = BigInt(Math.floor(expectedEth * (1 - slippagePct / 100) * 1e18));
  const tx = encodeV4ExactInSingle(key, zeroForOne, tokensIn, minOut, Math.floor(Date.now() / 1000) + 120);
  return sendAndWait(pub, wallet, tx);
}

export async function evmBalances(pub: PublicClient, owner: Address, token: Address) {
  const [wei, bal] = await Promise.all([
    pub.getBalance({ address: owner }),
    pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }).catch(() => 0n),
  ]);
  return { eth: Number(wei) / 1e18, tokens: Number(bal) / 1e18 };
}
