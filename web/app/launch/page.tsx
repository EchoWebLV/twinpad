"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getJson, postJson, usd, type Launch, type Quote } from "../../lib/api";
import { Nav, short } from "../components/ui";
import { useWallets, type DetectedWallet, type PayChain } from "../../lib/wallet";

export default function LaunchForm() {
  const router = useRouter();
  const [q, setQ] = useState<Quote | null>(null);
  const [f, setF] = useState({ name: "", symbol: "", description: "", twitter: "", telegram: "", devWallet: "" });
  const [image, setImage] = useState<string>("");
  const [chain, setChain] = useState<PayChain>("sol");
  const [connected, setConnected] = useState<{ key: string; address: string } | null>(null);
  const wallets = useWallets();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    getJson<Quote>("/api/paid/quote").then(setQ).catch((e) => setErr((e as Error).message));
  }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: k === "symbol" ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") : e.target.value });
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setErr("image max 2 MB"); return; }
    setErr(null);
    const r = new FileReader();
    r.onload = () => setImage(String(r.result));
    r.readAsDataURL(file);
  };
  const pick = async (w: DetectedWallet) => {
    setChain(w.chain);
    setConnected(null);
    setErr(null);
    try {
      const address = await w.connect();
      setF((prev) => ({ ...prev, devWallet: address }));
      setConnected({ key: w.key, address });
    } catch (er) {
      setErr((er as Error).message);
    }
  };
  const manual = (c: PayChain) => {
    setChain(c);
    setConnected(null);
    setF((prev) => ({ ...prev, devWallet: "" }));
  };
  const payLine = (c: PayChain) => (c === "sol" ? `pay ${q ? `${q.depositSol} SOL` : "SOL"} on Solana` : `pay ${q ? `${q.depositEth} ETH` : "ETH"} on Robinhood Chain`);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const rec = await postJson<Launch>("/api/paid", { ...f, payChain: chain, imageDataUrl: image });
      router.push(`/launch/${rec.id}`);
    } catch (er) {
      setErr((er as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="shell">
      <Nav />
      <div className="ph-row r">
        <div>
          <h1>Launch a coin</h1>
          <p className="desc">Fill this in once. You pay one deposit, the pool fronts both chains, and your coin is live on pump.fun and Pons in the same minute.</p>
        </div>
      </div>
      <div className="two">
        <form className="box form r" style={{ "--i": 1 } as React.CSSProperties} onSubmit={submit}>
          <span className="cap">01 · Token</span>
          <div className="grid2">
            <label>Name<input required maxLength={32} placeholder="Yellow Cat" value={f.name} onChange={set("name")} /></label>
            <label>Symbol<input required maxLength={10} placeholder="YCAT" value={f.symbol} onChange={set("symbol")} /></label>
          </div>
          <label>Description<textarea required maxLength={500} placeholder="What is this coin about?" value={f.description} onChange={set("description")} /></label>
          <label>
            Image · PNG or JPEG · up to 2 MB
            <span className="drop">
              <input type="file" accept="image/png,image/jpeg" onChange={onFile} />
              {image ? <img src={image} alt="" /> : <span className="ph"><i /></span>}
              <span>{image ? "Click to replace" : "Click to choose an image"}<br /><small className="dim">Square works best. This is the pump.fun and Pons token image.</small></span>
            </span>
          </label>
          <div className="grid3">
            <label>Twitter<input placeholder="https://x.com/…" value={f.twitter} onChange={set("twitter")} /></label>
            <label>Telegram<input placeholder="https://t.me/…" value={f.telegram} onChange={set("telegram")} /></label>
            <label>Website<input value="Twinpad coin page" readOnly disabled /><small className="dim">Always points to your coin on this pad.</small></label>
          </div>
          <div className="fcap">02 · Wallet</div>
          {wallets.length > 0 ? (
            <div className="wallets">
              {wallets.map((w) => (
                <button type="button" key={w.key} className={`wal ${connected?.key === w.key ? "on" : ""}`} onClick={() => pick(w)}>
                  <b>{w.icon && <img src={w.icon} alt="" />}{w.name}<em>{w.chain === "sol" ? "Solana" : "Robinhood"}</em></b>
                  <span>{connected?.key === w.key ? `connected ${short(connected.address, 5)}` : payLine(w.chain)}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="mute" style={{ margin: "4px 0 14px", fontSize: 13 }}>No wallet detected in this browser. Install Phantom (Solana) or MetaMask / Rabby (Robinhood Chain), or paste an address below.</p>
          )}
          <label>
            <span style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap" }}>
              {chain === "sol" ? "Your Solana wallet" : "Your Robinhood Chain wallet"}
              <span className="chainpick">
                <button type="button" className={chain === "sol" ? "on" : ""} onClick={() => manual("sol")}>SOL</button>
                <button type="button" className={chain === "eth" ? "on" : ""} onClick={() => manual("eth")}>ETH</button>
              </span>
            </span>
            <input required placeholder={chain === "sol" ? "Solana address · pays the deposit and receives refunds" : "0x… · pays the deposit and receives refunds"} value={f.devWallet} onChange={(e) => { setConnected(null); set("devWallet")(e); }} />
          </label>
          {err && <p className="err" style={{ marginBottom: 14 }}>{err}</p>}
          <div className="actions">
            <button className="btn y" disabled={busy || !image}>{busy ? "Creating" : "Create launch"} <span className="ar">→</span></button>
            <span className="mute" style={{ fontSize: 13 }}>Next step: pay {q ? (chain === "sol" ? `${q.depositSol} SOL` : `${q.depositEth} ETH`) : "the deposit"} from the wallet above.</span>
          </div>
        </form>
        <div className="sticky stack">
          <div className="box preview r" style={{ "--i": 2 } as React.CSSProperties}>
            {image ? <img src={image} alt="" /> : <div className="ph"><i /></div>}
            <h2>{f.name || "Your coin"}</h2>
            <p className="up mute">${f.symbol || "SYMBOL"}</p>
          </div>
          <div className="box r" style={{ "--i": 3 } as React.CSSProperties}>
            <span className="cap">03 · Your deposit</span>
            {q ? (
              <>
                <div className="kv"><span>You deposit</span><b>{chain === "sol" ? `${q.depositSol} SOL` : `${q.depositEth} ETH`} <span className="mute">≈ {usd(q.depositSol * q.fx.SOL)}</span></b></div>
                <div className="kv"><span>Paid on</span><b>{chain === "sol" ? "Solana" : "Robinhood Chain"}</b></div>
                <div className="kv"><span>Pool fronts on Solana</span><b>{q.frontSol} SOL</b></div>
                <div className="kv"><span>Pool fronts on Robinhood</span><b>{q.frontEth} ETH</b></div>
                <div className="kv"><span>Dev buy on pump.fun</span><b>{q.devBuySol} SOL · {q.supplyPct.pump}% supply</b></div>
                <div className="kv"><span>Maker buy on Pons</span><b>{q.ponsEth} ETH · {q.supplyPct.pons}% supply</b></div>
                <div className="kv"><span>Opening FDV</span><b className="y">{usd(q.openingFdv)}</b></div>
                <div className="kv"><span>Landing</span><b>pump {usd(q.landing.pump)} <span className="dim">/</span> pons {usd(q.landing.pons)}</b></div>
              </>
            ) : <p className="mute"><i className="ld" />loading quote</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
