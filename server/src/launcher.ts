import crypto from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { formatEther, getAddress, type Address, type Hex, type PublicClient } from "viem";
import type { Config } from "./config.js";
import type { Registry } from "./registry.js";
import { step, transition, type LaunchRecord } from "./record.js";
import type { Pool } from "./pool.js";
import { sweepEth, sweepSol } from "./pool.js";
import { coinExists, readBondingCurve, sendSigned, tradeLocal } from "./solana/pump.js";
import { buildLaunchCalldata, launchPreflight, parseTokenLaunched, readCurve, walletClient, PONS, TOKEN_SUPPLY } from "./evm/pons.js";
import { evmBuy, evmBalances, solanaBalances } from "./trade.js";
import { grossFromNet, quoteNetForFdv } from "./quote.js";

export interface LaunchCtx {
  cfg: Config;
  registry: Registry;
  pool: Pool;
  conn: Connection;
  pub: PublicClient;
  fx: () => Promise<{ SOL: number; ETH: number }>;
  log?: (msg: string) => void;
}

/**
 * Run one launch from its per-coin wallets. Copies TWINE V2 (spec §10.5): fronting → deposit to pool →
 * pump.fun create + dev buy (creator = maker on Solana) → Pons launchToken from the launcher with the
 * maker as creatorFeeRecipient and exemptions [launcher, maker] → maker curve buy sized to land at the
 * pump.fun fdv → live. Sets status failed with `launch.error` on any throw; retry re-enters here.
 * Every chain step is checkpointed in `launch.txs`, so a retry never repeats a step that succeeded.
 */
export async function runLaunch(ctx: LaunchCtx, rec: LaunchRecord): Promise<void> {
  const log = ctx.log ?? ((m: string) => console.log(`[launch ${rec.id}] ${m}`));
  const save = () => ctx.registry.save(rec);
  const now = () => Date.now();
  const keys = ctx.registry.keys(rec.id);
  const mintKp = Keypair.fromSecretKey(Uint8Array.from(keys.mint));
  const creator = Keypair.fromSecretKey(Uint8Array.from(keys.solCreator));
  const payKp = Keypair.fromSecretKey(Uint8Array.from(keys.payment));
  const launcherW = walletClient(ctx.cfg.evm.rpcUrl, keys.evmLauncher);
  const makerW = walletClient(ctx.cfg.evm.rpcUrl, keys.evmMaker);
  const launcher = getAddress(rec.wallets.evmLauncher) as Address;
  const maker = getAddress(rec.wallets.evmMaker) as Address;
  const MINT = mintKp.publicKey;
  const L = rec.launch;
  const T = rec.token;

  if (rec.status === "approved") transition(rec, "launching", now());
  if (rec.status !== "launching") throw new Error(`runLaunch on status ${rec.status}`);
  L.startedAt ??= now();
  L.error = null;
  save();

  try {
    // ---- preflight
    const pf = await launchPreflight(ctx.pub, launcher);
    if (!pf.canLaunch || !pf.launchEnabled || !pf.config.enabled) throw new Error("Pons factory refuses launches right now");
    const launchFee = Number(formatEther(pf.launchFee));
    const needEth = launchFee + ctx.cfg.launch.evmGasLauncher + rec.front.eth;
    if (!L.txs.frontSol || !L.txs.frontRhMaker) {
      const can = await ctx.pool.canFront(rec.front.sol, needEth);
      if (!can.ok) throw new Error(`pool below floor: ${JSON.stringify(can.balances)} needs ${rec.front.sol} SOL + ${needEth.toFixed(4)} ETH`);
    }
    if (!L.salt) L.salt = `0x${crypto.randomBytes(32).toString("hex")}`;
    step(rec, "preflight", now(), { launchFee, canLaunch: pf.canLaunch });
    save();

    // ---- fronting: pool → creator (SOL), pool → launcher (fee + gas), pool → maker (front.eth)
    if (!L.txs.frontSol) {
      L.txs.frontSol = await ctx.pool.transferSol(creator.publicKey, rec.front.sol);
      save();
    }
    if (!L.txs.frontRhLauncher) {
      L.txs.frontRhLauncher = await ctx.pool.transferEth(launcher, launchFee + ctx.cfg.launch.evmGasLauncher);
      save();
    }
    if (!L.txs.frontRhMaker) {
      L.txs.frontRhMaker = await ctx.pool.transferEth(maker, rec.front.eth);
      save();
    }
    if (!rec.front.at) {
      rec.front = { ...rec.front, at: now(), txSol: L.txs.frontSol, txRhLauncher: L.txs.frontRhLauncher, txRhMaker: L.txs.frontRhMaker };
      step(rec, "fronting", now(), { sol: rec.front.sol, eth: rec.front.eth, txSol: L.txs.frontSol, txRh: L.txs.frontRhMaker });
      save();
    }

    // ---- deposit → pool
    if (!rec.payment.toPoolTx) {
      if (rec.payment.chain === "eth") {
        const swept = await sweepEth(ctx.pub, ctx.cfg.evm.rpcUrl, keys.evmPayment, ctx.pool.evmAddress);
        rec.payment.toPoolTx = swept?.sig ?? "none";
        step(rec, "deposit_to_pool", now(), { amount: swept?.eth ?? 0, unit: "ETH", tx: swept?.sig ?? null });
      } else {
        const swept = await sweepSol(ctx.conn, payKp, ctx.pool.sol.publicKey);
        rec.payment.toPoolTx = swept?.sig ?? "none";
        step(rec, "deposit_to_pool", now(), { amount: swept?.sol ?? 0, unit: "SOL", tx: swept?.sig ?? null });
      }
      save();
    }
    step(rec, "funded", now(), { makerSol: rec.front.sol, makerEth: rec.front.eth });
    log("funded");

    // ---- pump.fun create + dev buy, creator == maker
    if (!L.txs.pumpCreate) {
      const exists = await coinExists(ctx.conn, MINT);
      if (exists.onChain) throw new Error("mint already has on-chain history");
      const tx = await tradeLocal({
        publicKey: creator.publicKey.toBase58(),
        action: "create",
        tokenMetadata: { name: T.name, symbol: T.symbol, uri: T.metadataUri },
        mint: MINT.toBase58(),
        denominatedInSol: "true",
        amount: rec.quote.devBuySol,
        slippage: ctx.cfg.solana.slippagePct,
        priorityFee: ctx.cfg.solana.priorityFeeSol,
        pool: "pump",
      });
      tx.sign([mintKp, creator]);
      L.txs.pumpCreate = await sendSigned(ctx.conn, tx);
      L.pumpMint = MINT.toBase58();
      L.launchedAt = now();
      save();
    }
    log(`pump create ${L.txs.pumpCreate}`);
    const curve = await readBondingCurve(ctx.conn, MINT);
    if (!curve) throw new Error("bonding curve not found after create");
    const fx = await ctx.fx();
    const targetUsd = curve.fdvSol * fx.SOL;

    // ---- Pons launchToken from the launcher wallet
    if (!L.txs.ponsLaunch) {
      const data = buildLaunchCalldata(
        {
          name: T.name, symbol: T.symbol, logo: `ipfs://${T.imageCid}`, description: T.description,
          twitter: T.twitter, telegram: T.telegram, website: T.website,
          creatorFeeRecipient: maker, creatorTaxBps: ctx.cfg.evm.creatorTaxBps, salt: L.salt as Hex, exemptions: [launcher, maker],
        },
        pf.expectedEconomics,
      );
      // The RPC behind a load balancer can lag the launcher's fresh balance by a few seconds, which makes
      // estimateGas fail with "exceeds the balance of the account". Retry before giving up.
      let gas = 0n;
      for (let attempt = 1; ; attempt++) {
        try {
          gas = await ctx.pub.estimateGas({ account: launcher, to: PONS.factory, data, value: pf.launchFee });
          break;
        } catch (e) {
          const msg = (e as Error).message.split("\n")[0];
          if (attempt >= 10) throw new Error(`launchToken estimateGas failed after ${attempt} attempts: ${msg}`);
          log(`estimateGas attempt ${attempt} failed (${msg}), retrying`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      const hash = await launcherW.sendTransaction({ account: launcherW.account!, chain: launcherW.chain, to: PONS.factory, data, value: pf.launchFee, gas: (gas * 12n) / 10n });
      L.txs.ponsLaunch = hash;
      save();
    }
    if (!L.ponsToken) {
      const receipt = await ctx.pub.waitForTransactionReceipt({ hash: L.txs.ponsLaunch as Hex, timeout: 180_000 });
      if (receipt.status !== "success") throw new Error(`launchToken reverted: ${L.txs.ponsLaunch}`);
      const launched = parseTokenLaunched(receipt.logs as unknown as { address: Address; data: Hex; topics: Hex[] }[]);
      if (!launched) throw new Error("TokenLaunched event not found");
      L.ponsToken = launched.token;
      L.ponsCurve = launched.curve;
      save();
    }
    log(`pons token ${L.ponsToken}`);

    // ---- maker buy on Pons sized to land at the pump.fun fdv
    if (!L.txs.evmMakerBuy) {
      // Same RPC lag as above: a replica may not see the launch for a while. Poll until it does.
      let c: Awaited<ReturnType<typeof readCurve>> | null = null;
      for (let attempt = 1; !c; attempt++) {
        try {
          c = await readCurve(ctx.pub, L.ponsToken as Address);
        } catch (e) {
          const msg = (e as Error).message.split("\n")[0];
          if (attempt >= 60) throw new Error(`readCurve failed after ${attempt} attempts: ${msg}`);
          if (attempt === 1 || attempt % 10 === 0) log(`readCurve attempt ${attempt} failed (${msg}), retrying`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      const Q = Number(c.quoteReserve) / 1e18, Tk = Number(c.tokenReserve) / 1e18;
      const net = quoteNetForFdv(Q, Tk, TOKEN_SUPPLY, targetUsd / fx.ETH);
      const wanted = grossFromNet(net, Number(c.feeBps), c.creatorTaxBps);
      const eth = Math.max(0, Math.min(wanted, rec.front.eth - ctx.cfg.launch.evmMakerCash));
      step(rec, "pons_sizing", now(), { targetUsd: Math.round(targetUsd), wantedEth: wanted, eth });
      L.txs.evmMakerBuy = eth > 0 ? await evmBuy(ctx.pub, makerW, L.ponsToken as Address, eth, ctx.cfg.solana.slippagePct) : "skipped";
      save();
    }

    // ---- live
    const [s, e] = await Promise.all([solanaBalances(ctx.conn, creator.publicKey, MINT), evmBalances(ctx.pub, maker, L.ponsToken as Address)]);
    rec.seed = { pumpTokens: Math.round(s.tokens), ponsTokens: Math.round(e.tokens), openingFdv: Math.round(targetUsd), at: now() };
    step(rec, "launched", now(), { pumpMint: L.pumpMint, ponsToken: L.ponsToken, pilePump: rec.seed.pumpTokens, pilePons: rec.seed.ponsTokens });
    transition(rec, "live", now(), { coinId: rec.id });
    save();
    log("live");
  } catch (e) {
    L.error = (e as Error).message.split("\n")[0].slice(0, 300);
    transition(rec, "failed", now(), { error: L.error });
    save();
    log(`FAILED: ${L.error}`);
  }
}

export function pairOf(rec: LaunchRecord) {
  return { pumpMint: new PublicKey(rec.launch.pumpMint!), ponsToken: getAddress(rec.launch.ponsToken!) as Address };
}
