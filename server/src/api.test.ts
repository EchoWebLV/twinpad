import { test } from "node:test";
import assert from "node:assert/strict";
import { Router, RateLimit } from "./api.js";

test("router matches method + params and returns 404 otherwise", async () => {
  const r = new Router();
  r.get("/api/paid/:id", (p) => ({ id: p.id }));
  assert.deepEqual(await r.dispatch("GET", "/api/paid/doggo-ab12", null, {}), { status: 200, body: { id: "doggo-ab12" } });
  assert.equal((await r.dispatch("POST", "/api/paid/x", null, {})).status, 404);
});

test("admin routes need the token", async () => {
  const r = new Router("tok");
  r.post("/api/admin/ping", () => ({ ok: true }), { admin: true });
  assert.equal((await r.dispatch("POST", "/api/admin/ping", null, {})).status, 401);
  assert.equal((await r.dispatch("POST", "/api/admin/ping", null, { "x-admin-token": "tok" })).status, 200);
});

test("rate limit: one per window per key", () => {
  const rl = new RateLimit(1000);
  assert.equal(rl.allow("ip", 0), true);
  assert.equal(rl.allow("ip", 500), false);
  assert.equal(rl.allow("ip", 1001), true);
});
