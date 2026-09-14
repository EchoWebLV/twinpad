"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getJson, postJson, usd, type Launch, type OperatorQuoteResp } from "../../../lib/api";
import { Nav } from "../../components/ui";

/** Hidden operator page: the pool launches its own coin with a locked allocation and a two-sided opening bundle. Not linked from the nav. */
export default function OperatorLaunch() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [f, setF] = useState({ name: "", symbol: "", description: "", twitter: "", telegram: "" });
  const [image, setImage] = useState("");
  const [p, setP] = useState({ lockPct: "15", bundleSol: "", ponsEth: "", cashSol: "", cashEth: "", maxLossUsd: "500" });
  const [q, setQ] = useState<OperatorQuoteResp | null>(null);
  const [seeded, setSeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    try { setToken(localStorage.getItem("adminToken") ?? ""); } catch { /* private mode */ }
  }, []);
  const saveToken = (t: string) => {
    setToken(t);
    try { localStorage.setItem("adminToken", t); } catch { /* private mode */ }
  };
  const num = (s: string) => (Number.isFinite(Number(s)) && s !== "" ? Number(s) : 0);
  // Quote on every change (debounced). The first quote seeds the dollar defaults: $2k on pump.fun, parity on Pons, $300 cash a side.
  useEffect(() => {
    if (!token) return;
    let live = true;
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ lockPct: p.lockPct || "0", bundleSol: p.bundleSol || "1", ponsEth: p.ponsEth || "0.01", cashSol: p.cashSol || "0", cashEth: p.cashEth || "0" });
      getJson<OperatorQuoteResp>(`/api/admin/launch/quote?${qs}`, token)
        .then((r) => {
          if (!live) return;
          setQ(r);
          setErr(null);
          if (!seeded) {
            setSeeded(true);
            const sol = (u: number) => (Math.round((u / r.shape.fx.SOL) * 1e4) / 1e4).toString();
            const eth = (u: number) => (Math.round((u / r.shape.fx.ETH) * 1e6) / 1e6).toString();
            setP((prev) => ({ ...prev, bundleSol: prev.bundleSol || sol(2000), cashSol: prev.cashSol || sol(300), cashEth: prev.cashEth || eth(300), ponsEth: prev.ponsEth || "" }));
          }
        })
        .catch((e) => { if (live) setErr((e as Error).message); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [token, p.lockPct, p.bundleSol, p.ponsEth, p.cashSol, p.cashEth, seeded]);
  // Once the bundle is known, prefill the Pons side with parity (the ETH that lands Pons on the pump.fun fdv).
  useEffect(() => {
    if (q && seeded && p.bundleSol && !p.ponsEth && q.shape.pons.parityEth > 0) setP((prev) => ({ ...prev, ponsEth: q.shape.pons.parityEth.toString() }));
  }, [q, seeded, p.bundleSol, p.ponsEth]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: k === "symbol" ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") : e.target.value });
  const setNum = (k: keyof typeof p) => (e: React.ChangeEvent<HTMLInputElement>) => setP({ ...p, [k]: e.target.value });
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setErr("image max 2 MB"); return; }
    setErr(null);
    const r = new FileReader();
    r.onload = () => setImage(String(r.result));
    r.readAsDataURL(file);
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q?.pool.ok) { setErr("the pool cannot fund this shape"); return; }
    if (!confirm(`Launch ${f.name} ($${f.symbol}) from the pool?\n\n${q.shape.pool.sol} SOL + ${q.shape.pool.eth} ETH leave the pool. ${q.shape.lock.pct}% of supply is locked on both chains.`)) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await postJson<{ record: Launch }>("/api/admin/launch", {
        ...f, imageDataUrl: image,
        lockPct: num(p.lockPct), bundleSol: num(p.bundleSol), ponsEth: num(p.ponsEth), cashSol: num(p.cashSol), cashEth: num(p.cashEth), maxLossUsd: p.maxLossUsd === "" ? null : num(p.maxLossUsd),
      }, token);
      router.push(`/launch/${r.record.id}`);
    } catch (er) {
      setErr((er as Error).message);
      setBusy(false);
    }
  };
  const s = q?.shape;
  const fxs = s ? s.fx : null;
  const inUsd = (n: number, sym: "SOL" | "ETH") => (fxs ? ` ≈ ${usd(n * fxs[sym])}` : "");
  return (
    <div className="shell">
      <Nav />
      <div className="ph-row r">
        <div>
          <h1>Operator launch</h1>
          <p className="desc">The pool launches its own coin: a locked allocation bought first on both chains, then the peg's opening bundle on pump.fun and Pons in the same launch. No deposit, no exit timer. Lands on the coin page.</p>
        </div>
        <div className="form" style={{ marginLeft: "auto", minWidth: 280 }}>
          <label style={{ margin: 0 }}>Admin token<input type="password" placeholder="ADMIN_TOKEN" value={token} onChange={(e) => saveToken(e.target.value)} /></label>
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
              <span>{image ? "Click to replace" : "Click to choose an image"}</span>
            </span>
          </label>
          <div className="grid2">
            <label>Twitter<input placeholder="https://x.com/…" value={f.twitter} onChange={set("twitter")} /></label>
            <label>Telegram<input placeholder="https://t.me/…" value={f.telegram} onChange={set("telegram")} /></label>
          </div>
          <div className="fcap">02 · Shape</div>
          <div className="grid3">
            <label>Locked · % of supply<input type="number" min={0} max={40} step={0.5} inputMode="decimal" value={p.lockPct} onChange={setNum("lockPct")} /><small className="dim">Bought first on each chain by a lock wallet nothing ever trades or sweeps.</small></label>
            <label>pump.fun bundle · SOL<input type="number" min={0} step={0.01} inputMode="decimal" value={p.bundleSol} onChange={setNum("bundleSol")} /><small className="dim">The peg's opening buy, in the create bundle{s ? inUsd(num(p.bundleSol), "SOL") : ""}.</small></label>
            <label>Pons buy · ETH<input type="number" min={0} step={0.0001} inputMode="decimal" value={p.ponsEth} onChange={setNum("ponsEth")} /><small className="dim">Parity is {s ? `${s.pons.parityEth} ETH` : "…"}{s ? inUsd(s.pons.parityEth, "ETH") : ""}. <a href="#" onClick={(e) => { e.preventDefault(); if (s) setP({ ...p, ponsEth: s.pons.parityEth.toString() }); }}>use parity</a></small></label>
          </div>
          <div className="grid3">
            <label>Maker cash · SOL<input type="number" min={0} step={0.01} inputMode="decimal" value={p.cashSol} onChange={setNum("cashSol")} /><small className="dim">Kept in the Solana maker for buys{s ? inUsd(num(p.cashSol), "SOL") : ""}; the recovery sweep leaves it alone.</small></label>
            <label>Maker cash · ETH<input type="number" min={0} step={0.0001} inputMode="decimal" value={p.cashEth} onChange={setNum("cashEth")} /><small className="dim">Same on Robinhood{s ? inUsd(num(p.cashEth), "ETH") : ""}.</small></label>
            <label>Loss cap · USD<input type="number" min={0} step={50} inputMode="decimal" placeholder="server default" value={p.maxLossUsd} onChange={setNum("maxLossUsd")} /><small className="dim">This coin's own maker halt. Only loss past it counts toward the pool breaker.</small></label>
          </div>
          {err && <p className="err" style={{ marginBottom: 14 }}>{err}</p>}
          <div className="actions">
            <button className="btn y" disabled={busy || !image || !token || !q?.pool.ok}>{busy ? "Launching" : "Launch from the pool"} <span className="ar">→</span></button>
            <span className="mute" style={{ fontSize: 13 }}>{q ? (q.pool.ok ? "Pool can fund this shape." : "Pool cannot fund this shape.") : "Enter the admin token for a quote."}</span>
          </div>
        </form>
        <div className="sticky stack">
          <div className="box preview r" style={{ "--i": 2 } as React.CSSProperties}>
            {image ? <img src={image} alt="" /> : <div className="ph"><i /></div>}
            <h2>{f.name || "Your coin"}</h2>
            <p className="up mute">${f.symbol || "SYMBOL"}</p>
          </div>
          <div className="box r" style={{ "--i": 3 } as React.CSSProperties}>
            <span className="cap">03 · What the pool does</span>
            {s && q ? (
              <>
                <div className="kv"><span>Locked on pump.fun</span><b>{s.lock.pct}% · {s.lock.solGross} SOL <span className="mute">{inUsd(s.lock.solGross, "SOL")}</span></b></div>
                <div className="kv"><span>Locked on Pons</span><b>{s.lock.pct}% · {s.lock.ethGross} ETH <span className="mute">{inUsd(s.lock.ethGross, "ETH")}</span></b></div>
                <div className="kv"><span>Peg buys on pump.fun</span><b>{s.pump.devBuySol} SOL · {s.pump.supplyPct}% supply</b></div>
                <div className="kv"><span>Peg buys on Pons</span><b>{s.pons.eth} ETH · {s.pons.supplyPct}% supply</b></div>
                <div className="kv"><span>Ours at open</span><b>{Math.round((s.lock.pct + s.pump.supplyPct) * 10) / 10}% <span className="dim">/</span> {Math.round((s.lock.pct + s.pons.supplyPct) * 10) / 10}%</b></div>
                <div className="kv"><span>Landing</span><b>pump {usd(s.pump.fdv)} <span className="dim">/</span> pons {usd(s.pons.fdv)}</b></div>
                <div className="kv"><span>Opening gap</span><b className={s.gapPct <= 5 ? "y" : "red"}>{s.gapPct}%</b></div>
                <div className="kv"><span>Leaves the pool</span><b>{s.pool.sol} SOL + {s.pool.eth} ETH</b></div>
                <div className="kv"><span>Pool free above floor</span><b className={q.pool.ok ? "" : "red"}>{q.pool.free.sol.toFixed(2)} SOL · {q.pool.free.eth.toFixed(4)} ETH</b></div>
                {!q.pool.ok && <p className="err" style={{ marginTop: 10, fontSize: 13 }}>Short by {Math.max(0, s.pool.sol - q.pool.free.sol).toFixed(2)} SOL and {Math.max(0, s.pool.eth - q.pool.free.eth).toFixed(4)} ETH.</p>}
              </>
            ) : <p className="mute"><i className="ld" />{token ? "loading quote" : "admin token needed"}</p>}
            <p className="dim" style={{ marginTop: 12, fontSize: 12 }}>Both maker fronts include fees, gas and the cash reserve. The lock wallets get their buy plus rent/gas. The coin opens with the exit timer set to keep; close it from the admin page.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
