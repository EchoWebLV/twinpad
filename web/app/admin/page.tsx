"use client";
import { useEffect, useState } from "react";
import { getJson, postJson, type CoinSummary, type Launch, type PoolSummary } from "../../lib/api";

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
      setLaunches(l);
      setCoins(c);
      setPool(p);
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
      setMsg(`ok ${path}`);
      await refresh();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const saveToken = (t: string) => {
    setToken(t);
    try { localStorage.setItem("adminToken", t); } catch { /* private mode */ }
  };
  return (
    <main>
      <header><a href="/" className="back">← all coins</a><div><h1>Admin</h1></div></header>
      <div className="card form">
        <label>Admin token<input type="password" value={token} onChange={(e) => saveToken(e.target.value)} /></label>
        {msg && <p className="sub">{msg}</p>}
      </div>
      {pool && (
        <div className="card">
          <h2>Pool</h2>
          <div className="row"><span>Solana <span className="ca">{pool.solana.address}</span></span><b>{pool.solana.balance.toFixed(3)} SOL (floor {pool.solana.floor})</b></div>
          <div className="row"><span>Robinhood <span className="ca">{pool.robinhood.address}</span></span><b>{pool.robinhood.balance.toFixed(4)} ETH (floor {pool.robinhood.floor})</b></div>
          <div className="row"><span>outstanding</span><b>{pool.outstanding.sol.toFixed(3)} SOL · {pool.outstanding.eth.toFixed(4)} ETH</b></div>
          <div className="row"><span>live / launching / queued / open</span><b>{pool.counts.live} / {pool.counts.launching} / {pool.counts.queued} / {pool.counts.open}</b></div>
        </div>
      )}
      <div className="card">
        <h2>Launches</h2>
        <table>
          <thead><tr><th>id</th><th>status</th><th>paid</th><th>error</th><th>actions</th></tr></thead>
          <tbody>
            {launches.map((l) => (
              <tr key={l.id}>
                <td><a href={`/launch/${l.id}`}>{l.id}</a></td>
                <td>{l.status}</td>
                <td>{l.payment.receivedSol}/{l.payment.requiredSol}</td>
                <td className="err">{l.launch.error ?? ""}</td>
                <td>
                  {l.status === "paid" && <button onClick={() => act(`/api/admin/paid/${l.id}/approve`)}>approve</button>}
                  {["awaiting_deposit", "paid", "approved"].includes(l.status) && <button onClick={() => act(`/api/admin/paid/${l.id}/reject`, { note: prompt("note") ?? null })}>reject</button>}
                  {l.status === "failed" && <button onClick={() => act(`/api/admin/paid/${l.id}/retry`)}>retry</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>Makers</h2>
        <table>
          <thead><tr><th>coin</th><th>maker</th><th>actions</th></tr></thead>
          <tbody>
            {coins.map((c) => (
              <tr key={c.id}>
                <td><a href={`/coin/${c.id}`}>{c.id}</a></td>
                <td>{c.maker}</td>
                <td>
                  <button onClick={() => act(`/api/admin/coins/${c.id}/maker/halt`)}>halt</button>
                  <button onClick={() => act(`/api/admin/coins/${c.id}/maker/resume`)}>resume</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
