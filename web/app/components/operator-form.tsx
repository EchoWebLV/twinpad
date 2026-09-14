"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getJson, postJson, usd, type BundleCheckResp, type Launch, type OperatorQuoteResp } from "../../lib/api";
import { Nav } from "./ui";

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

interface BuyerRow { sol: string; evm: string; buySol: string; buyEth: string }
const rowFilled = (r: BuyerRow) => !!(r.sol.trim() || r.evm.trim() || r.buySol.trim() || r.buyEth.trim());
/** The server takes buyers as lines: `<solana key or -> <robinhood key or -> <buy SOL> <buy ETH>`; blank rows are left out. */
const rowsToLines = (rows: BuyerRow[]) => rows.filter(rowFilled).map((r) => `${r.sol.trim() || "-"} ${r.evm.trim() || "-"} ${r.buySol.trim() || "0"} ${r.buyEth.trim() || "0"}`).join("\n");

/**
 * Hidden operator form, two modes. Pool: the pool funds generated lock wallets and the peg's opening bundle.
 * Bundle: the operator pastes the dev wallet (locked allocation) and buyer wallets; each pays its own buys, the pool
 * fronts only the maker, creator and launcher. Keys go straight to the server on submit and are never kept here.
 */
export function OperatorForm({ bundle = false }: { bundle?: boolean }) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [f, setF] = useState({ name: "", symbol: "", description: "", twitter: "", telegram: "" });
  const [image, setImage] = useState("");
  const [p, setP] = useState({ lockPct: "15", bundleSol: "", ponsEth: "", cashSol: "", cashEth: "", maxLossUsd: "500" });
  const [w, setW] = useState({ devSol: "", devEvm: "" });
  const [rows, setRows] = useState<BuyerRow[]>([{ sol: "", evm: "", buySol: "", buyEth: "" }]);
  const [reveal, setReveal] = useState(false);
  const [q, setQ] = useState<BundleCheckResp | null>(null);
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
  const buyerLines = rowsToLines(rows);
  const walletsBody = () => (bundle && (w.devSol.trim() || w.devEvm.trim() || buyerLines) ? { dev: { sol: w.devSol.trim(), evm: w.devEvm.trim() }, buyers: buyerLines } : null);
  // Quote on every change (debounced). The first quote seeds the dollar defaults: $2k on pump.fun, parity on Pons, $300 cash a side.
  // Bundle mode posts the pasted keys to the check route, which answers with each wallet's balance against its need.
  useEffect(() => {
    if (!token) return;
    let live = true;
    const t = setTimeout(() => {
      const nums = { lockPct: p.lockPct || "0", bundleSol: p.bundleSol || "1", ponsEth: p.ponsEth || "0.01", cashSol: p.cashSol || "0", cashEth: p.cashEth || "0" };
      const req = bundle
        ? postJson<BundleCheckResp>("/api/admin/launch/check", { ...nums, selfFunded: true, wallets: walletsBody() }, token)
        : getJson<OperatorQuoteResp>(`/api/admin/launch/quote?${new URLSearchParams(nums)}`, token).then((r) => ({ ...r, wallets: null, limits: { maxBuyers: 0, buySolMax: 0, buyEthMax: 0 } }));
      req
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
    }, 400);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, p.lockPct, p.bundleSol, p.ponsEth, p.cashSol, p.cashEth, seeded, bundle, w.devSol, w.devEvm, buyerLines]);
  // Once the bundle is known, prefill the Pons side with parity (the ETH that lands Pons on the pump.fun fdv).
  useEffect(() => {
    if (q && seeded && p.bundleSol && !p.ponsEth && q.shape.pons.parityEth > 0) setP((prev) => ({ ...prev, ponsEth: q.shape.pons.parityEth.toString() }));
  }, [q, seeded, p.bundleSol, p.ponsEth]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: k === "symbol" ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") : e.target.value });
  const setNum = (k: keyof typeof p) => (e: React.ChangeEvent<HTMLInputElement>) => setP({ ...p, [k]: e.target.value });
  const setW1 = (k: keyof typeof w) => (e: React.ChangeEvent<HTMLInputElement>) => setW({ ...w, [k]: e.target.value });
  const setRow = (i: number, k: keyof BuyerRow) => (e: React.ChangeEvent<HTMLInputElement>) => setRows(rows.map((r, n) => (n === i ? { ...r, [k]: e.target.value } : r)));
  const addRow = () => setRows([...rows, { sol: "", evm: "", buySol: "", buyEth: "" }]);
  const removeRow = (i: number) => setRows(rows.length === 1 ? [{ sol: "", evm: "", buySol: "", buyEth: "" }] : rows.filter((_, n) => n !== i));
  // the check answers one row per filled buyer, in order: map each visible row to its check
  const checkOf = (i: number) => {
    if (!q?.wallets || !rowFilled(rows[i])) return null;
    const n = rows.slice(0, i).filter(rowFilled).length;
    return q.wallets.rows[n + 1] ?? null;
  };
  const devCheck = q?.wallets?.rows[0] ?? null;
  const holds = (c: { balance: number; need: number; ok: boolean } | null | undefined, unit: string) =>
    c ? <small className={c.ok ? "y" : "red"}>holds {c.balance} / needs {c.need} {unit}</small> : <small className="dim">&nbsp;</small>;
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setErr("image max 2 MB"); return; }
    setErr(null);
    const r = new FileReader();
    r.onload = () => setImage(String(r.result));
    r.readAsDataURL(file);
  };
  const walletsOk = !bundle || (!!q?.wallets && q.wallets.ok);
  const ready = !!q?.pool.ok && walletsOk;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q?.pool.ok) { setErr("the pool cannot fund this shape"); return; }
    if (bundle && !q.wallets) { setErr("paste the dev wallet keys first"); return; }
    if (bundle && !walletsOk) { setErr("a pasted wallet is short"); return; }
    const s = q.shape;
    const msg = bundle
      ? `Launch ${f.name} ($${f.symbol}) with your wallets?\n\n${s.pool.sol} SOL + ${s.pool.eth} ETH leave the pool for the maker. The dev wallet buys ${s.lock.pct}% of supply on both chains (${s.lock.solGross} SOL + ${s.lock.ethGross} ETH). ${s.buyers.count} buyer wallet(s) spend ${s.buyers.sol} SOL + ${s.buyers.eth} ETH.`
      : `Launch ${f.name} ($${f.symbol}) from the pool?\n\n${s.pool.sol} SOL + ${s.pool.eth} ETH leave the pool. ${s.lock.pct}% of supply is locked on both chains.`;
    if (!confirm(msg)) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await postJson<{ record: Launch }>("/api/admin/launch", {
        ...f, imageDataUrl: image,
        lockPct: num(p.lockPct), bundleSol: num(p.bundleSol), ponsEth: num(p.ponsEth), cashSol: num(p.cashSol), cashEth: num(p.cashEth), maxLossUsd: p.maxLossUsd === "" ? null : num(p.maxLossUsd),
        wallets: walletsBody(),
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
          <h1>{bundle ? "Bundle launch" : "Operator launch"}</h1>
          <p className="desc">
            {bundle
              ? "Your wallets, our peg. Paste the dev wallet that holds the locked allocation and the wallets that buy in the opening bundle; each pays its own buys. The pool fronts only the maker. No deposit, no exit timer. Lands on the coin page."
              : "The pool launches its own coin: a locked allocation bought first on both chains, then the peg's opening bundle on pump.fun and Pons in the same launch. No deposit, no exit timer. Lands on the coin page."}
          </p>
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
          {bundle && (
            <>
              <div className="fcap">02 · Your wallets <a href="#" className="dim" style={{ marginLeft: 8, fontWeight: 400 }} onClick={(e) => { e.preventDefault(); setReveal(!reveal); }}>{reveal ? "hide keys" : "show keys"}</a></div>
              <div className="bw">
                <div className="bw-head"><span>Solana · pump.fun</span><span>Robinhood · Pons</span><span /></div>
                <div className="bw-row dev">
                  <div className="bw-tag">Dev wallet · locks {p.lockPct || 0}%</div>
                  <div className="bw-cell" data-side="Solana · pump.fun">
                    <input type={reveal ? "text" : "password"} autoComplete="off" spellCheck={false} placeholder="Solana secret key (base58)" value={w.devSol} onChange={setW1("devSol")} />
                    <small className="dim">buys {s ? `${s.lock.solGross} SOL` : "…"} in the create bundle</small>
                    {holds(devCheck?.sol, "SOL")}
                  </div>
                  <div className="bw-cell" data-side="Robinhood · Pons">
                    <input type={reveal ? "text" : "password"} autoComplete="off" spellCheck={false} placeholder="Robinhood private key (0x…)" value={w.devEvm} onChange={setW1("devEvm")} />
                    <small className="dim">buys {s ? `${s.lock.ethGross} ETH` : "…"} right after the Pons launch</small>
                    {holds(devCheck?.evm, "ETH")}
                  </div>
                  <span />
                </div>
                {rows.map((r, i) => {
                  const c = checkOf(i);
                  return (
                    <div className="bw-row" key={i}>
                      <div className="bw-tag">Buyer {i + 1}</div>
                      <div className="bw-cell" data-side="Solana · pump.fun">
                        <div className="bw-pair">
                          <input type={reveal ? "text" : "password"} autoComplete="off" spellCheck={false} placeholder="Solana secret key · empty = skips pump.fun" value={r.sol} onChange={setRow(i, "sol")} />
                          <div className="amt"><span>buys</span><input type="number" min={0} step={0.01} inputMode="decimal" placeholder="0.00 SOL" value={r.buySol} onChange={setRow(i, "buySol")} /></div>
                        </div>
                        {holds(c?.sol, "SOL")}
                      </div>
                      <div className="bw-cell" data-side="Robinhood · Pons">
                        <div className="bw-pair">
                          <input type={reveal ? "text" : "password"} autoComplete="off" spellCheck={false} placeholder="Robinhood private key · empty = skips Pons" value={r.evm} onChange={setRow(i, "evm")} />
                          <div className="amt"><span>buys</span><input type="number" min={0} step={0.0001} inputMode="decimal" placeholder="0.0000 ETH" value={r.buyEth} onChange={setRow(i, "buyEth")} /></div>
                        </div>
                        {holds(c?.evm, "ETH")}
                      </div>
                      <button type="button" className="bw-x" title="Remove wallet" onClick={() => removeRow(i)}>×</button>
                    </div>
                  );
                })}
                <div className="bw-foot">
                  <button type="button" className="btn sm" onClick={addRow} disabled={!!q?.limits?.maxBuyers && rows.length >= q.limits.maxBuyers}>+ Add wallet</button>
                  <small className="dim">Leave a chain empty for a wallet that skips it. The first two buyers ride in the pump.fun create bundle after the maker, the rest buy right after it lands; Pons buys follow the maker's in order. Each wallet must hold its buy plus fees{q?.limits?.maxBuyers ? ` · max ${q.limits.maxBuyers} wallets` : ""}.</small>
                </div>
              </div>
            </>
          )}
          <div className="fcap">{bundle ? "03" : "02"} · Shape</div>
          <div className="grid3">
            <label>Locked · % of supply<input type="number" min={0} max={40} step={0.5} inputMode="decimal" value={p.lockPct} onChange={setNum("lockPct")} /><small className="dim">{bundle ? "Bought first on each chain by the dev wallet; never traded or swept." : "Bought first on each chain by a lock wallet nothing ever trades or sweeps."}</small></label>
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
            <button className="btn y" disabled={busy || !image || !token || !ready}>{busy ? "Launching" : bundle ? "Launch the bundle" : "Launch from the pool"} <span className="ar">→</span></button>
            <span className="mute" style={{ fontSize: 13 }}>
              {!q ? "Enter the admin token for a quote." : !q.pool.ok ? "Pool cannot fund this shape." : bundle && !q.wallets ? "Paste the dev wallet keys." : bundle && !walletsOk ? "A pasted wallet is short." : bundle ? "Pool and wallets are funded." : "Pool can fund this shape."}
            </span>
          </div>
        </form>
        <div className="sticky stack">
          <div className="box preview r" style={{ "--i": 2 } as React.CSSProperties}>
            {image ? <img src={image} alt="" /> : <div className="ph"><i /></div>}
            <h2>{f.name || "Your coin"}</h2>
            <p className="up mute">${f.symbol || "SYMBOL"}</p>
          </div>
          <div className="box r" style={{ "--i": 3 } as React.CSSProperties}>
            <span className="cap">{bundle ? "04" : "03"} · {bundle ? "What happens at open" : "What the pool does"}</span>
            {s && q ? (
              <>
                <div className="kv"><span>{bundle ? "Dev wallet on pump.fun" : "Locked on pump.fun"}</span><b>{s.lock.pct}% · {s.lock.solGross} SOL <span className="mute">{inUsd(s.lock.solGross, "SOL")}</span></b></div>
                <div className="kv"><span>{bundle ? "Dev wallet on Pons" : "Locked on Pons"}</span><b>{s.lock.pct}% · {s.lock.ethGross} ETH <span className="mute">{inUsd(s.lock.ethGross, "ETH")}</span></b></div>
                <div className="kv"><span>Peg buys on pump.fun</span><b>{s.pump.devBuySol} SOL · {s.pump.supplyPct}% supply</b></div>
                <div className="kv"><span>Peg buys on Pons</span><b>{s.pons.eth} ETH · {s.pons.supplyPct}% supply</b></div>
                {bundle && <div className="kv"><span>Buyers ({s.buyers.count})</span><b>{s.buyers.sol} SOL · {s.buyers.pumpSupplyPct}% <span className="dim">/</span> {s.buyers.eth} ETH · {s.buyers.ponsSupplyPct}%</b></div>}
                <div className="kv"><span>Ours at open</span><b>{Math.round((s.lock.pct + s.pump.supplyPct + s.buyers.pumpSupplyPct) * 10) / 10}% <span className="dim">/</span> {Math.round((s.lock.pct + s.pons.supplyPct + s.buyers.ponsSupplyPct) * 10) / 10}%</b></div>
                <div className="kv"><span>Landing</span><b>pump {usd(bundle ? s.buyers.pumpFdv : s.pump.fdv)} <span className="dim">/</span> pons {usd(bundle ? s.buyers.ponsFdv : s.pons.fdv)}</b></div>
                <div className="kv"><span>Opening gap</span><b className={s.gapPct <= 5 ? "y" : "red"}>{s.gapPct}%</b></div>
                <div className="kv"><span>Leaves the pool</span><b>{s.pool.sol} SOL + {s.pool.eth} ETH</b></div>
                <div className="kv"><span>Pool free above floor</span><b className={q.pool.ok ? "" : "red"}>{q.pool.free.sol.toFixed(2)} SOL · {q.pool.free.eth.toFixed(4)} ETH</b></div>
                {!q.pool.ok && <p className="err" style={{ marginTop: 10, fontSize: 13 }}>Short by {Math.max(0, s.pool.sol - q.pool.free.sol).toFixed(2)} SOL and {Math.max(0, s.pool.eth - q.pool.free.eth).toFixed(4)} ETH.</p>}
                {bundle && q.wallets && !q.wallets.ok && <p className="err" style={{ marginTop: 10, fontSize: 13 }}>{q.wallets.short.join(". ")}.</p>}
              </>
            ) : <p className="mute"><i className="ld" />{token ? "loading quote" : "admin token needed"}</p>}
            <p className="dim" style={{ marginTop: 12, fontSize: 12 }}>
              {bundle
                ? "The pool fronts the maker (opening buys, gas, cash reserve), the creator and the launcher. Your wallets pay their own buys; the server checks every balance before the pool moves anything and never sells, sweeps or closes them. The coin opens with the exit timer set to keep; close it from the admin page."
                : "Both maker fronts include fees, gas and the cash reserve. The lock wallets get their buy plus rent/gas. The coin opens with the exit timer set to keep; close it from the admin page."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
