"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getJson, img, usd, type Launch } from "../../../lib/api";
import { Copy, Img, Nav, PONS, PUMP, SOLSCAN, Status, short } from "../../components/ui";

interface Phantom {
  isPhantom?: boolean;
  connect(): Promise<{ publicKey: PublicKey }>;
  signAndSendTransaction(tx: Transaction): Promise<{ signature: string }>;
}
declare global {
  interface Window { solana?: Phantom }
}

const STEPS: { key: string; title: string; desc: string }[] = [
  { key: "created", title: "Created", desc: "Metadata pinned, wallets generated" },
  { key: "status:paid", title: "Deposit received", desc: "Watcher confirmed your SOL" },
  { key: "status:approved", title: "Approved", desc: "Cleared for launch" },
  { key: "fronting", title: "Pool fronted", desc: "Maker wallets funded on both chains" },
  { key: "deposit_to_pool", title: "Deposit swept", desc: "Your deposit moved into the pool" },
  { key: "pump_create", title: "pump.fun live", desc: "Token created, dev buy done" },
  { key: "pons_launch", title: "Pons live", desc: "Token launched on Robinhood Chain" },
  { key: "launched", title: "Maker sized", desc: "Both sides opened at the same FDV" },
  { key: "status:live", title: "Live", desc: "Market maker holding the band" },
];

export default function LaunchPage() {
  const { id } = useParams<{ id: string }>();
  const [l, setL] = useState<Launch | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [payErr, setPayErr] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = () => { setNow(Date.now()); getJson<Launch>(`/api/paid/${id}`).then((x) => { setL(x); setErr(null); }).catch((e) => setErr((e as Error).message)); };
    tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, [id]);
  const pay = async () => {
    if (!l) return;
    setPaying(true);
    setPayErr(null);
    try {
      if (!window.solana?.isPhantom) throw new Error("Phantom not found. Send the SOL manually to the address below.");
      const { publicKey } = await window.solana.connect();
      if (publicKey.toBase58() !== l.devWallet) throw new Error(`Connect the wallet you entered (${short(l.devWallet)}).`);
      const { blockhash } = await getJson<{ blockhash: string }>("/api/chain/blockhash");
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash }).add(
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: new PublicKey(l.payment.address), lamports: Math.round(l.payment.requiredSol * LAMPORTS_PER_SOL) }),
      );
      const r = await window.solana.signAndSendTransaction(tx);
      setSent(r.signature);
    } catch (e) {
      setPayErr((e as Error).message);
    }
    setPaying(false);
  };
  if (err) return <div className="shell"><Nav /><div className="empty" style={{ marginTop: 40 }}><b>Could not load launch</b>{err}</div></div>;
  if (!l) return <div className="shell"><Nav /><p className="mute" style={{ marginTop: 40 }}><i className="ld" />loading</p></div>;

  const done = new Set<string>(l.launch.steps.map((s) => s.name));
  const stepNames = new Set(l.launch.steps.map((s) => s.name));
  if (stepNames.has("pons_sizing") || stepNames.has("launched")) done.add("pons_launch");
  if (stepNames.has("pons_sizing") || stepNames.has("launched") || l.launch.pumpMint) done.add("pump_create");
  const rank = (s: string) => ["awaiting_deposit", "paid", "approved", "launching", "live"].indexOf(s);
  if (rank(l.status) >= rank("paid")) done.add("status:paid");
  if (rank(l.status) >= rank("approved")) done.add("status:approved");
  if (l.status === "live") done.add("status:live");
  const firstOpen = STEPS.findIndex((s) => !done.has(s.key));
  const stepAt = (k: string) => l.launch.steps.find((s) => s.name === k)?.at;
  const remaining = Math.max(0, l.payment.deadlineAt - now);
  const terminal = ["rejected", "expired", "failed"].includes(l.status);

  return (
    <div className="shell">
      <Nav />
      <div className="ph-row r">
        <Img src={img(l.token.imageCid)} size={76} />
        <div>
          <h1>{l.token.name}<small>${l.token.symbol}</small></h1>
          <p className="desc">{l.token.description}</p>
        </div>
        <Status status={l.status} />
      </div>

      <div className="two">
        <div className="stack">
          {l.status === "awaiting_deposit" && (
            <div className="box on r" style={{ "--i": 1 } as React.CSSProperties}>
              <span className="cap">01 · Pay the deposit</span>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                <div className="pay-amt">{l.payment.requiredSol}<small>SOL</small></div>
                <span className={`st ${remaining < 10 * 60e3 ? "bad" : ""}`}>{Math.floor(remaining / 60000)} min left</span>
              </div>
              <p className="mute">from <span className="mono">{short(l.devWallet, 6)}</span> to this address:</p>
              <div className="addr"><code>{l.payment.address}</code><Copy text={l.payment.address} /></div>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", marginTop: 14 }}>
                <button className="btn y" onClick={pay} disabled={paying}>{paying ? "Waiting for Phantom" : "Pay with Phantom"} <span className="ar">→</span></button>
                <span className="up mute">received {l.payment.receivedSol} / {l.payment.requiredSol} SOL</span>
              </div>
              {sent && <p className="mute" style={{ marginTop: 12 }}>Sent · <a className="lnk y" href={SOLSCAN(sent)} target="_blank" rel="noreferrer">view on Solscan ↗</a> · the watcher confirms it within a few seconds.</p>}
              {payErr && <p className="err" style={{ marginTop: 12 }}>{payErr}</p>}
              <p className="dim" style={{ marginTop: 14, fontSize: 12 }}>Only the wallet above counts. Payments from other wallets and payments after the deadline are refunded automatically.</p>
            </div>
          )}
          {l.status === "live" && (
            <div className="box on r">
              <span className="cap">Live</span>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
                <a className="btn y" href={`/coin/${l.id}`}>Open the live view <span className="ar">→</span></a>
                <a className="lnk" href={PUMP(l.wallets.pumpMint)} target="_blank" rel="noreferrer">pump.fun ↗</a>
                {l.launch.ponsToken && <a className="lnk" href={PONS(l.launch.ponsToken)} target="_blank" rel="noreferrer">Pons ↗</a>}
              </div>
            </div>
          )}
          {l.status === "launching" && (
            <div className="box on r"><span className="st launching">Launching now</span><p className="mute" style={{ marginTop: 10 }}>Both chains are being set up. This page updates on its own.</p></div>
          )}
          {terminal && (
            <div className="box r">
              <h2 className="red">{l.status === "failed" ? "Launch failed" : l.status === "rejected" ? "Rejected" : "Expired"}</h2>
              {l.launch.error && <p className="err">{l.launch.error}</p>}
              {l.approval.note && <p className="mute">{l.approval.note}</p>}
              {l.status === "failed" && <p className="mute" style={{ marginTop: 8 }}>An operator can retry from the checkpoint it stopped at. Nothing is re-spent.</p>}
              {l.refund.txs.length > 0 && <p className="mute" style={{ marginTop: 8 }}>Refunded {l.refund.sol} SOL · {l.refund.txs.map((t) => <a key={t} className="lnk y" href={SOLSCAN(t)} target="_blank" rel="noreferrer">tx ↗ </a>)}</p>}
            </div>
          )}

          <div className="box r" style={{ "--i": 2 } as React.CSSProperties}>
            <h2>Progress</h2>
            <ol className="timeline">
              {STEPS.map((s, i) => {
                const isDone = done.has(s.key);
                const isNow = !isDone && i === firstOpen && !terminal;
                const at = stepAt(s.key) ?? (s.key === "created" ? l.createdAt : s.key === "status:paid" ? l.payment.paidAt : s.key === "status:approved" ? l.approval.at : undefined);
                return (
                  <li key={s.key} className={isDone ? "done" : isNow ? "now" : ""}>
                    <span className="tick" />
                    <div><div className="t">{s.title}</div><div className="d">{s.desc}</div></div>
                    <span className="when">{at ? new Date(at).toLocaleTimeString() : ""}</span>
                  </li>
                );
              })}
            </ol>
          </div>

          {l.launch.steps.length > 0 && (
            <div className="box r" style={{ "--i": 3 } as React.CSSProperties}>
              <h2>Log</h2>
              <table className="log">
                <tbody>
                  {[...l.launch.steps].reverse().map((s, i) => (
                    <tr key={i}>
                      <td>{new Date(s.at).toLocaleTimeString()}</td>
                      <td className="k">{s.name}</td>
                      <td className="mono">{Object.entries(s).filter(([k]) => k !== "at" && k !== "name").map(([k, v]) => `${k}=${String(v)}`).join("  ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="sticky stack">
          <div className="box r" style={{ "--i": 2 } as React.CSSProperties}>
            <span className="cap">Addresses</span>
            <div className="kv"><span>pump.fun CA</span><b className="mono">{short(l.wallets.pumpMint, 6)}</b></div>
            <div className="addr" style={{ marginTop: 0 }}><code>{l.wallets.pumpMint}</code><Copy text={l.wallets.pumpMint} /></div>
            {l.launch.ponsToken && (
              <>
                <div className="kv"><span>Pons token</span><b className="mono">{short(l.launch.ponsToken, 6)}</b></div>
                <div className="addr" style={{ marginTop: 0 }}><code>{l.launch.ponsToken}</code><Copy text={l.launch.ponsToken} /></div>
              </>
            )}
            <div className="kv"><span>Dev wallet</span><b className="mono">{short(l.devWallet, 6)}</b></div>
            <div className="kv"><span>Maker · Solana</span><b className="mono">{short(l.wallets.solCreator, 6)}</b></div>
            <div className="kv"><span>Maker · Robinhood</span><b className="mono">{short(l.wallets.evmMaker, 6)}</b></div>
          </div>
          <div className="box r" style={{ "--i": 3 } as React.CSSProperties}>
            <span className="cap">Sizing</span>
            <div className="kv"><span>Deposit</span><b>{l.quote.depositSol} SOL</b></div>
            <div className="kv"><span>Pool fronts</span><b>{l.quote.frontSol} SOL + {l.quote.frontEth} ETH</b></div>
            <div className="kv"><span>Opening FDV</span><b className="y">{usd(l.quote.openingFdv)}</b></div>
            <div className="kv"><span>Landing</span><b>pump {usd(l.quote.landing.pump)} <span className="dim">/</span> pons {usd(l.quote.landing.pons)}</b></div>
            <div className="kv"><span>Maker inventory</span><b>{l.quote.supplyPct.pump}% · {l.quote.supplyPct.pons}%</b></div>
          </div>
          {(l.token.twitter || l.token.website || l.token.telegram) && (
            <div className="box tags r" style={{ "--i": 4 } as React.CSSProperties}>
              {l.token.twitter && <a className="lnk" href={l.token.twitter} target="_blank" rel="noreferrer">Twitter ↗</a>}
              {l.token.website && <a className="lnk" href={l.token.website} target="_blank" rel="noreferrer">Website ↗</a>}
              {l.token.telegram && <a className="lnk" href={l.token.telegram} target="_blank" rel="noreferrer">Telegram ↗</a>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
