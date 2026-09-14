"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getJson, img, usd, type Launch } from "../../../lib/api";

interface Phantom {
  isPhantom?: boolean;
  connect(): Promise<{ publicKey: PublicKey }>;
  signAndSendTransaction(tx: Transaction): Promise<{ signature: string }>;
}
declare global {
  interface Window { solana?: Phantom }
}

const ORDER = ["created", "status:paid", "status:approved", "status:launching", "fronting", "deposit_to_pool", "funded", "launched", "status:live"];

export default function LaunchPage() {
  const { id } = useParams<{ id: string }>();
  const [l, setL] = useState<Launch | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [payErr, setPayErr] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => getJson<Launch>(`/api/paid/${id}`).then((x) => { setL(x); setErr(null); }).catch((e) => setErr((e as Error).message));
    tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, [id]);
  const pay = async () => {
    if (!l) return;
    setPaying(true);
    setPayErr(null);
    try {
      if (!window.solana?.isPhantom) throw new Error("Phantom not found; send the SOL manually to the address below");
      const { publicKey } = await window.solana.connect();
      if (publicKey.toBase58() !== l.devWallet) throw new Error(`connect the wallet you entered (${l.devWallet.slice(0, 6)}…)`);
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
  if (err) return <main><p className="err">{err}</p></main>;
  if (!l) return <main><p className="sub">loading…</p></main>;
  const done = new Set(l.launch.steps.map((s) => s.name));
  const remaining = Math.max(0, l.payment.deadlineAt - Date.now());
  return (
    <main>
      <header>
        <a href="/" className="back">← all coins</a>
        <img src={img(l.token.imageCid)} alt="" />
        <div>
          <h1>{l.token.name} · ${l.token.symbol}</h1>
          <div className="sub">{l.token.description}</div>
        </div>
        <span className={`status ${l.status === "live" ? "live" : ""}`}>{l.status}</span>
      </header>
      <div className="card">
        <div className="row"><span>pump.fun CA</span><b className="ca">{l.wallets.pumpMint}</b></div>
        {l.launch.ponsToken && <div className="row"><span>Pons token</span><b className="ca">{l.launch.ponsToken}</b></div>}
        <div className="row"><span>opening fdv (quote)</span><b>{usd(l.quote.openingFdv)}</b></div>
        <div className="row"><span>pool fronts</span><b>{l.quote.frontSol} SOL + {l.quote.frontEth} ETH</b></div>
      </div>
      {l.status === "awaiting_deposit" && (
        <div className="card pay">
          <h2>Pay the deposit</h2>
          <div className="row"><span>amount</span><b>{l.payment.requiredSol} SOL</b></div>
          <div className="row"><span>from</span><b className="ca">{l.devWallet}</b></div>
          <div className="row"><span>to</span><b className="ca">{l.payment.address}</b></div>
          <div className="row"><span>received</span><b>{l.payment.receivedSol} SOL</b></div>
          <div className="row"><span>deadline</span><b>{Math.floor(remaining / 60000)} min left</b></div>
          <p>
            <button className="btn" onClick={pay} disabled={paying}>{paying ? "waiting for Phantom…" : "Pay with Phantom"}</button>
            <button className="btn ghost" onClick={() => navigator.clipboard.writeText(l.payment.address)}>Copy address</button>
          </p>
          {sent && <p className="sub">sent · <a href={`https://solscan.io/tx/${sent}`} target="_blank">view tx</a> · the watcher picks it up within a few seconds</p>}
          {payErr && <p className="err">{payErr}</p>}
          <p className="sub">Payments from any other wallet are refunded automatically. The deposit is refunded if the launch is rejected or expires.</p>
        </div>
      )}
      {l.status === "live" && <p><a className="btn" href={`/coin/${l.id}`}>Open the status page</a></p>}
      {l.launch.error && <p className="err">launch error: {l.launch.error}</p>}
      {l.approval.note && <p className="sub">note: {l.approval.note}</p>}
      {l.refund.txs.length > 0 && (
        <p className="sub">refunded {l.refund.sol} SOL · {l.refund.txs.map((t) => <a key={t} href={`https://solscan.io/tx/${t}`} target="_blank">tx </a>)}</p>
      )}
      <div className="card">
        <h2>Timeline</h2>
        <ol className="steps">{ORDER.map((n) => <li key={n} className={done.has(n) ? "done" : ""}>{n.replace("status:", "")}</li>)}</ol>
        <table>
          <tbody>
            {[...l.launch.steps].reverse().map((s, i) => (
              <tr key={i}>
                <td>{new Date(s.at).toLocaleTimeString()}</td>
                <td>{s.name}</td>
                <td className="ca">{Object.entries(s).filter(([k]) => k !== "at" && k !== "name").map(([k, v]) => `${k}=${String(v)}`).join("  ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

