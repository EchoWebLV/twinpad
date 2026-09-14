import http from "node:http";

type Params = Record<string, string>;
export type Headers = Record<string, string | string[] | undefined>;
type Handler = (params: Params, body: unknown, headers: Headers, ip: string) => unknown | Promise<unknown>;
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler; admin: boolean }

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Minimal router: `:param` segments, admin gate via x-admin-token. */
export class Router {
  private routes: Route[] = [];
  constructor(private adminToken = "") {}

  private add(method: string, pattern: string, handler: Handler, opts: { admin?: boolean } = {}) {
    const keys: string[] = [];
    const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_m, k: string) => { keys.push(k); return "([^/]+)"; }) + "$");
    this.routes.push({ method, re, keys, handler, admin: !!opts.admin });
  }
  get(p: string, h: Handler, o?: { admin?: boolean }) { this.add("GET", p, h, o); }
  post(p: string, h: Handler, o?: { admin?: boolean }) { this.add("POST", p, h, o); }

  async dispatch(method: string, pathname: string, body: unknown, headers: Headers, ip = ""): Promise<{ status: number; body: unknown }> {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.admin && (!this.adminToken || headers["x-admin-token"] !== this.adminToken)) return { status: 401, body: { error: "unauthorized" } };
      const params: Params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      try {
        return { status: 200, body: await r.handler(params, body, headers, ip) };
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 400;
        return { status, body: { error: (e as Error).message } };
      }
    }
    return { status: 404, body: { error: "not found" } };
  }
}

export class RateLimit {
  private last = new Map<string, number>();
  constructor(private windowMs: number) {}
  allow(key: string, now = Date.now()) {
    const t = this.last.get(key) ?? -Infinity;
    if (now - t < this.windowMs) return false;
    this.last.set(key, now);
    return true;
  }
}

/** Query string helper for handlers (`serve` puts the parsed query in headers.__query). */
export function query(headers: Headers): Record<string, string> {
  try { return JSON.parse((headers.__query as string) ?? "{}"); } catch { return {}; }
}

export function serve(router: Router, port: number, corsOrigin: string, maxBody = 3 * 1024 * 1024) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "access-control-allow-origin": corsOrigin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-admin-token",
      "cache-control": "no-store",
    };
    if (req.method === "OPTIONS") { res.writeHead(204, headers); res.end(); return; }
    let body: unknown = null;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > maxBody) { res.writeHead(413, headers); res.end(JSON.stringify({ error: "body too large" })); return; }
        chunks.push(c as Buffer);
      }
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null; } catch { res.writeHead(400, headers); res.end(JSON.stringify({ error: "bad json" })); return; }
    }
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() || req.socket.remoteAddress || "";
    const q: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (q[k] = v));
    const out = await router.dispatch(req.method ?? "GET", url.pathname, body, { ...req.headers, __query: JSON.stringify(q) }, ip);
    res.writeHead(out.status, headers);
    res.end(JSON.stringify(out.body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  });
  server.listen(port, () => console.log(`[api] listening on :${port}`));
  return server;
}
