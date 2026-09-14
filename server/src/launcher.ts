import crypto from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { formatEther, getAddress, type Address, type Hex, type PublicClient } from "viem";
import type { Config } from "./config.js";
import type { Registry } from "./registry.js";
import { newRetire, step, transition, type LaunchRecord } from "./record.js";
import type { Pool } from "./pool.js";
import { sweepEth, sweepSol } from "./pool.js";
import { coinExists, readBondingCurve, sendBundle, sendSigned, signatureOf, tradeLocal, tradeLocalBundle, waitForSignature, type TradeLocalBody } from "./solana/pump.js";
import { buildLaunchCalldata, launchPreflight, parseTokenLaunched, quoteBuyForTokens, readCurve, walletClient, PONS, TOKEN_SUPPLY } from "./evm/pons.js";
import { evmBuy, evmBalances, solanaBalances, solanaBuy } from "./trade.js";
import { grossFromNet, quoteNetForFdv, affordableBuySol, ponsOpeningEth } from "./quote.js";
import { alert } from "./alerts.js";

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
 * Run one launch from its per-coin wallets. Copies TWINE V2 (spec §10.5): deposit to pool → fronting →
 * pump.fun create (creator wallet, no dev buy) + opening buy (maker wallet) in one Jito bundle → Pons launchToken from the launcher with the
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
  // Records from before the split have no maker key: the creator keeps both roles for them.
  const solMaker = keys.solMaker ? Keypair.fromSecretKey(Uint8Array.from(keys.solMaker)) : creator;
  const split = solMaker.publicKey.toBase58() !== creator.publicKey.toBase58();
  const payKp = Keypair.fromSecretKey(Uint8Array.from(keys.payment));
  const launcherW = walletClient(ctx.cfg.evm.rpcUrl, keys.evmLauncher);
  const makerW = walletClient(ctx.cfg.evm.rpcUrl, keys.evmMaker);
  const launcher = getAddress(rec.wallets.evmLauncher) as Address;
  const maker = getAddress(rec.wallets.evmMaker) as Address;
  // Operator launches: a locked allocation is bought first on each chain from a lock wallet nothing else ever touches.
  const op = rec.operator && rec.operator.lockPct > 0 && keys.solLock && keys.evmLock ? rec.operator : null;
  const solLock = op ? Keypair.fromSecretKey(Uint8Array.from(keys.solLock!)) : null;
  const evmLockW = op ? walletClient(ctx.cfg.evm.rpcUrl, keys.evmLock!) : null;
  const evmLock = op ? getAddress(rec.wallets.evmLock!) as Address : null;
  const lockFundSol = op ? op.lock.fundSol : 0;
  const lockFundEth = op ? op.lock.fundEth : 0;
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
    const needEth = launchFee + ctx.cfg.launch.evmGasLauncher + rec.front.eth + lockFundEth;
    if (!L.salt) L.salt = `0x${crypto.randomBytes(32).toString("hex")}`;
    step(rec, "preflight", now(), { launchFee, canLaunch: pf.canLaunch });
    save();

    // Whatever reached the payment address beyond what the watcher credited (an unclaimed transfer, someone else's
    // ETH) is now in the pool: record it so the operator can refund it, and shout.
    const noteExcess = (swept: number) => {
      const excess = round6(swept - rec.payment.received);
      if (excess <= 0.000_01) return;
      step(rec, "deposit_excess", now(), { excess, unit: rec.payment.unit, received: rec.payment.received, swept });
      log(`deposit sweep moved ${excess} ${rec.payment.unit} more than credited; refund it with /api/admin/paid/${rec.id}/refund`);
      void alert(`${rec.id}: deposit sweep moved ${excess} ${rec.payment.unit} more than credited (${swept} vs ${rec.payment.received}); refund via /api/admin/paid/${rec.id}/refund`);
    };
    // ---- deposit → pool first: a deployer boost rides in the deposit and the pool fronts it right back
    if (!rec.payment.toPoolTx) {
      if (rec.payment.chain === "eth") {
        const swept = await sweepEth(ctx.pub, ctx.cfg.evm.rpcUrl, keys.evmPayment, ctx.pool.evmAddress);
        rec.payment.toPoolTx = swept?.sig ?? "none";
        step(rec, "deposit_to_pool", now(), { amount: swept?.eth ?? 0, unit: "ETH", tx: swept?.sig ?? null });
        noteExcess(swept?.eth ?? 0);
      } else {
        const swept = await sweepSol(ctx.conn, payKp, ctx.pool.sol.publicKey);
        rec.payment.toPoolTx = swept?.sig ?? "none";
        step(rec, "deposit_to_pool", now(), { amount: swept?.sol ?? 0, unit: "SOL", tx: swept?.sig ?? null });
        noteExcess(swept?.sol ?? 0);
      }
      save();
    }
    if (!L.txs.frontSol || !L.txs.frontRhMaker) {
      const can = await ctx.pool.canFront(rec.front.sol + lockFundSol, needEth);
      if (!can.ok) throw new Error(`pool below floor: ${JSON.stringify(can.balances)} needs ${round6(rec.front.sol + lockFundSol)} SOL + ${needEth.toFixed(4)} ETH`);
    }

    // ---- fronting: pool → maker (SOL for the opening buy + gas, incl. the deployer boost), pool → creator (create rent + tip),
    //      pool → launcher (fee + gas), pool → maker (front.eth)
    const creatorSol = split ? Math.min(ctx.cfg.launch.solCreatorSol, rec.front.sol / 2) : 0;
    if (!L.txs.frontSol) {
      L.txs.frontSol = await ctx.pool.transferSol(solMaker.publicKey, round6(rec.front.sol - creatorSol));
      save();
    }
    if (split && !L.txs.frontSolCreator) {
      L.txs.frontSolCreator = await ctx.pool.transferSol(creator.publicKey, creatorSol);
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
    if (op && solLock && evmLock) {
      if (!L.txs.frontSolLock) {
        L.txs.frontSolLock = await ctx.pool.transferSol(solLock.publicKey, round6(lockFundSol));
        op.locked.lockSol = round6(lockFundSol);
        op.locked.txSol = L.txs.frontSolLock;
        save();
      }
      if (!L.txs.frontEthLock) {
        L.txs.frontEthLock = await ctx.pool.transferEth(evmLock, lockFundEth);
        op.locked.lockEth = lockFundEth;
        op.locked.txEth = L.txs.frontEthLock;
        step(rec, "fronting_lock", now(), { pct: op.lockPct, sol: op.locked.lockSol, eth: op.locked.lockEth, solLock: rec.wallets.solLock, evmLock: rec.wallets.evmLock, txSol: L.txs.frontSolLock, txEth: L.txs.frontEthLock });
        save();
      }
    }
    if (!rec.front.at) {
      rec.front = { ...rec.front, at: now(), txSol: L.txs.frontSol, txRhLauncher: L.txs.frontRhLauncher, txRhMaker: L.txs.frontRhMaker };
      step(rec, "fronting", now(), { sol: rec.front.sol, boostSol: rec.boostSol, eth: rec.front.eth, txSol: L.txs.frontSol, txRh: L.txs.frontRhMaker });
      save();
    }
    step(rec, "funded", now(), { makerSol: rec.front.sol, makerEth: rec.front.eth });
    log("funded");

    // ---- pump.fun create (creator, no dev buy) + opening buy (maker), atomic in one Jito bundle so nothing lands between them.
    //      Pre-split records keep the old single transaction: create + dev buy from the creator.
    const devBuy = rec.quote.devBuySol;
    if (!L.txs.pumpCreate) {
      const exists = await coinExists(ctx.conn, MINT);
      if (exists.onChain) {
        // A bundle landed but the record was not saved (crash in between): adopt the oldest signature on the mint.
        const sigs = await ctx.conn.getSignaturesForAddress(MINT, { limit: 1000 });
        L.txs.pumpCreate = sigs[sigs.length - 1]?.signature ?? "unknown";
        log(`mint already on chain, adopted ${L.txs.pumpCreate}`);
      } else if (!split) {
        const tx = await tradeLocal({
          publicKey: creator.publicKey.toBase58(),
          action: "create",
          tokenMetadata: { name: T.name, symbol: T.symbol, uri: T.metadataUri },
          mint: MINT.toBase58(),
          denominatedInSol: "true",
          amount: devBuy,
          slippage: ctx.cfg.solana.slippagePct,
          priorityFee: ctx.cfg.solana.priorityFeeSol,
          pool: "pump",
        });
        tx.sign([mintKp, creator]);
        L.txs.pumpCreate = await sendSigned(ctx.conn, tx);
        L.txs.pumpBuy = L.txs.pumpCreate;
      } else {
        const bodies: TradeLocalBody[] = [
          {
            publicKey: creator.publicKey.toBase58(),
            action: "create",
            tokenMetadata: { name: T.name, symbol: T.symbol, uri: T.metadataUri },
            mint: MINT.toBase58(),
            denominatedInSol: "true",
            amount: 0,
            slippage: ctx.cfg.solana.slippagePct,
            priorityFee: ctx.cfg.launch.jitoTipSol, // first tx's fee = bundle tip
            pool: "pump",
          },
          ...(op && solLock
            ? [{
                publicKey: solLock.publicKey.toBase58(),
                action: "buy" as const,
                mint: MINT.toBase58(),
                denominatedInSol: "true" as const,
                amount: op.lock.buySol,
                slippage: ctx.cfg.solana.slippagePct,
                priorityFee: ctx.cfg.solana.priorityFeeSol,
                pool: "pump" as const,
              }]
            : []),
          {
            publicKey: solMaker.publicKey.toBase58(),
            action: "buy",
            mint: MINT.toBase58(),
            denominatedInSol: "true",
            amount: devBuy,
            slippage: ctx.cfg.solana.slippagePct,
            priorityFee: ctx.cfg.solana.priorityFeeSol,
            pool: "pump",
          },
        ];
        const last = bodies.length - 1;
        let landed = false;
        for (let attempt = 1; attempt <= 3 && !landed; attempt++) {
          const txs = await tradeLocalBundle(bodies);
          txs[0].sign([mintKp, creator]);
          if (op && solLock) txs[1].sign([solLock]);
          txs[last].sign([solMaker]);
          const createSig = signatureOf(txs[0]);
          const bundleId = await sendBundle(ctx.cfg.launch.jitoBlockEngine, txs);
          log(`bundle ${attempt}: ${bundleId} create ${createSig}`);
          landed = await waitForSignature(ctx.conn, createSig, 45_000);
          if (!landed && (await coinExists(ctx.conn, MINT)).onChain) landed = true;
          if (landed) {
            L.txs.pumpCreate = createSig;
            L.txs.pumpBuy = signatureOf(txs[last]);
            if (op && solLock) L.txs.pumpLockBuy = signatureOf(txs[1]);
            step(rec, "pump_bundle", now(), { bundleId, attempt, create: createSig, lockBuy: L.txs.pumpLockBuy ?? null, buy: L.txs.pumpBuy, devBuySol: devBuy, lockSol: op?.lock.buySol ?? 0 });
          }
        }
        if (!landed) {
          // Jito would not land it: plain create from the creator, then the maker buys in the next transaction.
          log("bundle did not land after 3 attempts, falling back to create + buy in sequence");
          const tx = await tradeLocal({ ...bodies[0], priorityFee: ctx.cfg.solana.priorityFeeSol });
          tx.sign([mintKp, creator]);
          L.txs.pumpCreate = await sendSigned(ctx.conn, tx);
        }
      }
      L.pumpMint = MINT.toBase58();
      save();
    }
    // Bundle fell back to sequence (or a retry): the lock wallet buys before the maker so the shape stays lock-first.
    if (op && solLock && !L.txs.pumpLockBuy) {
      const held = await solanaBalances(ctx.conn, solLock.publicKey, MINT);
      if (held.tokens < 1) {
        const o = { slippagePct: ctx.cfg.solana.slippagePct, priorityFeeSol: ctx.cfg.solana.priorityFeeSol };
        const spend = Math.min(op.lock.buySol, affordableBuySol(held.sol));
        if (spend <= 0) throw new Error(`lock wallet holds ${held.sol.toFixed(4)} SOL, not enough for the lock buy`);
        if (spend < op.lock.buySol) log(`lock buy trimmed to ${spend} SOL (lock wallet holds ${held.sol.toFixed(4)})`);
        L.txs.pumpLockBuy = await solanaBuy(ctx.conn, solLock, MINT, spend, o);
        step(rec, "pump_lock_buy", now(), { sol: spend, quoted: op.lock.buySol, tx: L.txs.pumpLockBuy });
      } else L.txs.pumpLockBuy = "held";
      save();
    }
    // The opening buy is separate from the create in the split flow; make sure the maker actually holds tokens.
    if (split && !L.txs.pumpBuy) {
      const held = await solanaBalances(ctx.conn, solMaker.publicKey, MINT);
      if (held.tokens < 1) {
        const o = { slippagePct: ctx.cfg.solana.slippagePct, priorityFeeSol: ctx.cfg.solana.priorityFeeSol };
        // The buy costs devBuy × (1 + pump.fun + PumpPortal fees) plus rent: never ask for more than the maker can pay.
        const spend = Math.min(devBuy, affordableBuySol(held.sol));
        if (spend <= 0) throw new Error(`maker holds ${held.sol.toFixed(4)} SOL, not enough for the opening buy`);
        if (spend < devBuy) log(`opening buy trimmed to ${spend} SOL (maker holds ${held.sol.toFixed(4)})`);
        L.txs.pumpBuy = await solanaBuy(ctx.conn, solMaker, MINT, spend, o);
        step(rec, "pump_opening_buy", now(), { sol: spend, quoted: devBuy, tx: L.txs.pumpBuy });
      } else L.txs.pumpBuy = "held";
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
          creatorFeeRecipient: maker, creatorTaxBps: ctx.cfg.evm.creatorTaxBps, salt: L.salt as Hex, exemptions: evmLock ? [launcher, maker, evmLock] : [launcher, maker],
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

    // Same RPC lag as above: a replica may not see the launch for a while. Poll until it does.
    const readCurveRetry = async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await readCurve(ctx.pub, L.ponsToken as Address);
        } catch (e) {
          const msg = (e as Error).message.split("\n")[0];
          if (attempt >= 60) throw new Error(`readCurve failed after ${attempt} attempts: ${msg}`);
          if (attempt === 1 || attempt % 10 === 0) log(`readCurve attempt ${attempt} failed (${msg}), retrying`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };

    // ---- operator lock buy on Pons: exactly lockPct of supply from the lock wallet, before the maker's buy
    if (op && evmLockW && evmLock && !L.txs.evmLockBuy) {
      const held = await evmBalances(ctx.pub, evmLock, L.ponsToken as Address);
      if (held.tokens < 1) {
        const c = await readCurveRetry();
        const want = (BigInt(Math.round(op.lockPct * 100)) * 10n ** 27n) / 10_000n; // lockPct of 1e9 tokens, 18 decimals
        const q = await quoteBuyForTokens(ctx.pub, c.curve, want, evmLock);
        const gross = Number(q.quoteIn) / 1e18;
        const spend = Math.min(gross, Math.max(0, held.eth - 0.0005));
        if (spend <= 0) throw new Error(`lock wallet holds ${held.eth.toFixed(5)} ETH, not enough for the lock buy`);
        if (spend < gross) log(`Pons lock buy trimmed to ${spend} ETH (lock wallet holds ${held.eth.toFixed(5)}, wanted ${gross.toFixed(5)})`);
        L.txs.evmLockBuy = await evmBuy(ctx.pub, evmLockW, L.ponsToken as Address, Math.ceil(spend * 1e9) / 1e9, ctx.cfg.solana.slippagePct);
        step(rec, "pons_lock_buy", now(), { pct: op.lockPct, eth: spend, quotedEth: gross, snipeBps: Number(q.snipeBps), tx: L.txs.evmLockBuy });
      } else L.txs.evmLockBuy = "held";
      save();
    }

    // ---- maker buy on Pons sized to land at the pump.fun fdv (operator launches: the amount the operator chose)
    if (!L.txs.evmMakerBuy) {
      const c = await readCurveRetry();
      const Q = Number(c.quoteReserve) / 1e18, Tk = Number(c.tokenReserve) / 1e18;
      const net = quoteNetForFdv(Q, Tk, TOKEN_SUPPLY, targetUsd / fx.ETH);
      const wanted = grossFromNet(net, Number(c.feeBps), c.creatorTaxBps);
      let eth: number;
      if (rec.operator) {
        const held = await evmBalances(ctx.pub, maker, L.ponsToken as Address);
        eth = Math.max(0, Math.min(rec.operator.ponsEth, round6(held.eth - ctx.cfg.launch.evmMakerCash - rec.operator.cashEth)));
        if (eth < rec.operator.ponsEth) log(`Pons opening buy trimmed to ${eth} ETH (maker holds ${held.eth.toFixed(5)})`);
      } else eth = ponsOpeningEth(wanted, rec.front.eth, ctx.cfg.launch.evmMakerCash, ctx.cfg.launch.seedPons);
      step(rec, "pons_sizing", now(), { targetUsd: Math.round(targetUsd), wantedEth: wanted, eth, seeded: ctx.cfg.launch.seedPons, operator: !!rec.operator });
      L.txs.evmMakerBuy = eth > 0 ? await evmBuy(ctx.pub, makerW, L.ponsToken as Address, eth, ctx.cfg.solana.slippagePct) : "skipped";
      save();
    }

    // ---- live
    const [s, e] = await Promise.all([solanaBalances(ctx.conn, solMaker.publicKey, MINT), evmBalances(ctx.pub, maker, L.ponsToken as Address)]);
    rec.seed = { pumpTokens: Math.round(s.tokens), ponsTokens: Math.round(e.tokens), openingFdv: Math.round(targetUsd), at: now() };
    step(rec, "launched", now(), { pumpMint: L.pumpMint, ponsToken: L.ponsToken, pilePump: rec.seed.pumpTokens, pilePons: rec.seed.ponsTokens });
    // Stamped here, not at the pump.fun create: a retried launch must not inherit an exit timer that already ran out.
    L.launchedAt = now();
    if (op && solLock && evmLock) {
      const [ls, le] = await Promise.all([solanaBalances(ctx.conn, solLock.publicKey, MINT), evmBalances(ctx.pub, evmLock, L.ponsToken as Address)]);
      op.locked.pumpTokens = Math.round(ls.tokens);
      op.locked.ponsTokens = Math.round(le.tokens);
      // The operator's own coin: no exit timer, it stays until closed by hand.
      rec.retire = { ...newRetire(L.launchedAt, ctx.cfg.retire), keep: true };
      step(rec, "exit_keep", now(), { pumpTokens: op.locked.pumpTokens, ponsTokens: op.locked.ponsTokens, lockPct: op.lockPct });
    }
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

function round6(n: number) {
  return Math.round(n * 1e6) / 1e6;
}
