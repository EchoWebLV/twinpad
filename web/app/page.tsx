"use client";
import { useEffect, useState } from "react";
import { getJson, pct, usd, type CoinSummary, type Launch } from "../lib/api";

export default function Home() {
  const [coins, setCoins] = useState<CoinSummary[]>([]);
  const [launches, setLaunches] = useState<Launch[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const tick = async () => {
      try {
        const [c, l] = await Promise.all([getJson<CoinSummary[]>("/api/coins"), getJson<Launch[]>("/api/paid")]);
        setCoins(c);
        setLaunches(l);
        setErr(null);
      } catch (e) {
        setErr((e as Error).message);
      }
    };
    void tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, []);
  const open = launches.filter((l) => !["live", "rejected", "expired"].includes(l.status));
  return (
    <main>
      <header>
        <div>
          <h1>Twinpad</h1>
          <div className="sub">One coin, two chains. pump.fun on Solana and Pons on Robinhood Chain, held within a band by a market maker.</div>
        </div>
        <a className="btn" href="/launch">Launch a coin</a>
      </header>
      {err && <p className="err">API unreachable: {err}</p>}
      <h2>Live</h2>
      {coins.length === 0 && <p className="sub">No live coins yet.</p>}
      <div className="cards">
        {coins.map((c) => (
          <a key={c.id} className="card coin" href={`/coin/${c.id}`}>
            <img src={c.image} alt="" />
            <div>
              <b>{c.name}</b> <span className="sub">${c.symbol}</span>
              <div className="row"><span>pump.fun</span><b>{c.pumpFdv ? usd(c.pumpFdv) : "—"}</b></div>
              <div className="row"><span>Pons</span><b>{c.ponsFdv ? usd(c.ponsFdv) : "—"}</b></div>
              <div className="row"><span>gap</span><b className={c.inBand ? "ok" : "bad"}>{c.gap == null ? "—" : pct(c.gap)}</b></div>
            </div>
          </a>
        ))}
      </div>
      <h2>Launches</h2>
      {open.length === 0 && <p className="sub">Nothing in the queue.</p>}
      {open.length > 0 && (
        <table>
          <thead><tr><th>coin</th><th>status</th><th>dev</th><th>created</th></tr></thead>
          <tbody>
            {open.map((l) => (
              <tr key={l.id}>
                <td><a href={`/launch/${l.id}`}>{l.token.name} · ${l.token.symbol}</a></td>
                <td>{l.status}</td>
                <td className="ca">{l.devWallet.slice(0, 6)}…</td>
                <td>{new Date(l.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
