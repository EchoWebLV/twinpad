"use client";
import { useEffect, useState } from "react";
import { getJson, img, postJson, usd, type CoinSummary, type Launch, type PoolSummary } from "../../lib/api";
import { Img, Nav, Sh, Status, ago, short } from "../components/ui";

export default function Admin() {
  const [token, setToken] = useState("");
  const [launches, setLaunches] = useState<Launch[]>([]);
  const [coins, setCoins] = useState<CoinSummary[]>([]);
  const [pool, setPool] = useState<PoolSummary | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    try { setToken(localStorage.getItem("adminToken") ?? ""); } catch { /* private mode */ }
  }, []);
  const refresh = async () => {
    try {
      const [l, c, p] = await Promise.all([getJson<Launch[]>("/api/paid"), getJson<CoinSummary[]>("/api/coins"), getJson<PoolSummary>("/api/pool")]);
      setLaunches(l); setCoins(c); setPool(p);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, []);
  const act = async (path: string, body: unknown = {}) => {
    try {
      await postJson(path, body, token);
      setMsg(`ok · ${path}`);
      await refresh();
    } catch (e) {
      setMsg((e as Error).message);
    }
    setTimeout(() => setMsg(null), 4000);
  };
  const saveToken = (t: string) => {
    setToken(t);
    try { localStorage.setItem("adminToken", t); } catch { /* private mode */ }
  };
  const solOk = pool ? pool.solana.balance >= pool.solana.floor : null;
  const ethOk = pool ? pool.robinhood.balance >= pool.robinhood.floor : null;
  return (
    <div className="shell">
      <Nav />
      <div className="ph-row r">
        <div><h1>Admin</h1><p className="desc">Pool balances, approvals, retries and maker controls. Actions need the admin token.</p></div>
        <div className="form" style={{ marginLeft: "auto", minWidth: 280 }}>
          <label style={{ margin: 0 }}>Admin token<input type="password" placeholder="ADMIN_TOKEN" value={token} onChange={(e) => saveToken(e.target.value)} /></label>
        </div>
      </div>

      {pool && (
        <div className="strip r" style={{ "--i": 1 } as React.CSSProperties}>
          <div className="cell"><span>Pool · Solana</span><b className={solOk ? "" : "red"}>{pool.solana.balance.toFixed(3)} SOL</b><small>floor {pool.solana.floor} · {short(pool.solana.address, 5)}</small></div>
          <div className="cell"><span>Pool · Robinhood</span><b className={ethOk ? "" : "red"}>{pool.robinhood.balance.toFixed(4)} ETH</b><small>floor {pool.robinhood.floor} · {short(pool.robinhood.address, 5)}</small></div>
          <div className="cell"><span>Outstanding fronts</span><b>{pool.outstanding.sol.toFixed(2)} SOL</b><small>{pool.outstanding.eth.toFixed(4)} ETH</small></div>
          <div className="cell"><span>Live / launching / queued</span><b>{pool.counts.live} / {pool.counts.launching} / {pool.counts.queued}</b><small>{pool.counts.open} open</small></div>
        </div>
      )}

      <section className="section r" style={{ "--i": 2 } as React.CSSProperties}>
        <Sh n="01" title="Launches" sub={`${launches.length} total`} />
        {launches.length === 0 ? <div className="empty"><b>No launches</b></div> : (
          <div className="box" style={{ padding: "6px 16px 10px" }}>
            <table className="tbl">
              <thead><tr><th>coin</th><th>status</th><th>deposit</th><th>opening</th><th>created</th><th>note / error</th><th style={{ textAlign: "right" }}>actions</th></tr></thead>
              <tbody>
                {launches.map((l) => (
                  <tr key={l.id}>
                    <td><a href={`/launch/${l.id}`} style={{ display: "flex", alignItems: "center", gap: 12 }}><Img src={img(l.token.imageCid)} size={28} /><b>{l.token.name}</b><span className="mute">${l.token.symbol}</span><span className="mono dim">{l.id}</span></a></td>
                    <td><Status status={l.status} /></td>
                    <td><b>{l.payment.received}</b> / {l.payment.required} {l.payment.unit}</td>
                    <td><b>{usd(l.quote.openingFdv)}</b></td>
                    <td className="mono">{ago(l.createdAt)}</td>
                    <td className={l.launch.error ? "err" : ""} style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={l.launch.error ?? l.approval.note ?? ""}>{l.launch.error ?? l.approval.note ?? ""}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {l.status === "paid" && <button className="btn y sm" onClick={() => act(`/api/admin/paid/${l.id}/approve`)}>approve</button>}{" "}
                      {["awaiting_deposit", "paid", "approved"].includes(l.status) && <button className="btn red sm" onClick={() => act(`/api/admin/paid/${l.id}/reject`, { note: prompt("note") ?? null })}>reject</button>}{" "}
                      {l.status === "failed" && <button className="btn sm" onClick={() => act(`/api/admin/paid/${l.id}/retry`)}>retry</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section r" style={{ "--i": 3 } as React.CSSProperties}>
        <Sh n="02" title="Makers" sub={`${coins.length} live`} />
        {coins.length === 0 ? <div className="empty"><b>No live makers</b></div> : (
          <div className="box" style={{ padding: "6px 16px 10px" }}>
            <table className="tbl">
              <thead><tr><th>coin</th><th>pump.fun</th><th>Pons</th><th>gap</th><th>maker</th><th style={{ textAlign: "right" }}>actions</th></tr></thead>
              <tbody>
                {coins.map((c) => (
                  <tr key={c.id}>
                    <td><a href={`/coin/${c.id}`} style={{ display: "flex", alignItems: "center", gap: 12 }}><Img src={c.image} size={28} /><b>{c.name}</b><span className="mute">${c.symbol}</span></a></td>
                    <td><b>{c.pumpFdv ? usd(c.pumpFdv) : "—"}</b></td>
                    <td><b className="y">{c.ponsFdv ? usd(c.ponsFdv) : "—"}</b></td>
                    <td className={c.inBand == null ? "" : c.inBand ? "y" : "red"}>{c.gap == null ? "—" : `${(c.gap * 100).toFixed(2)}%`}</td>
                    <td><span className={`st ${c.maker === "running" ? "live" : c.maker === "halted" ? "bad" : "off"}`}>{c.maker}</span></td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn red sm" onClick={() => act(`/api/admin/coins/${c.id}/maker/halt`)}>halt</button>{" "}
                      <button className="btn sm" onClick={() => act(`/api/admin/coins/${c.id}/maker/resume`)}>resume</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}
