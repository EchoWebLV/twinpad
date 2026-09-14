import { encodeFunctionData, type PublicClient, type WalletClient } from "viem";
import { escrowAbi, PONS } from "./pons.js";

/** ETH the Pons creator-tax escrow holds for `recipient`. 0 when the read fails. */
export async function escrowBalance(pub: PublicClient, recipient: `0x${string}`): Promise<number> {
  const wei = await pub.readContract({ address: PONS.feeEscrow, abi: escrowAbi, functionName: "balanceOf", args: [recipient] }).catch(() => 0n);
  return Number(wei) / 1e18;
}

/** `claim()` on the Pons fee escrow from the recipient wallet, confirmed. Null when less than `minEth` is waiting. */
export async function claimEscrow(pub: PublicClient, wallet: WalletClient, minEth = 0): Promise<{ hash: string; eth: number } | null> {
  const me = wallet.account!.address;
  const eth = await escrowBalance(pub, me);
  if (eth <= 0 || eth < minEth) return null;
  const data = encodeFunctionData({ abi: escrowAbi, functionName: "claim" });
  const gas = await pub.estimateGas({ account: me, to: PONS.feeEscrow, data });
  const hash = await wallet.sendTransaction({ account: wallet.account!, chain: wallet.chain, to: PONS.feeEscrow, data, gas: (gas * 12n) / 10n });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rc.status !== "success") throw new Error(`escrow claim ${hash} reverted`);
  return { hash, eth };
}
