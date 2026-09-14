import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bans } from "./bans.js";

test("Bans refuses banned wallets and reserved names, case-insensitively, and persists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bans-"));
  const file = path.join(dir, "bans.json");
  const b = new Bans(file, { names: Bans.fromEnv("twinpad, twin"), wallets: ["0x7A521bb15B5BAE572460754b05Df9856209a6BCF"] });
  assert.equal(b.refuse({ name: "Unity", symbol: "UNITY", devWallet: "0x27Ea8603cDE813E8B5C46Fb11E68062125fF851B" }), null);
  assert.match(b.refuse({ name: "TwinPad Official", symbol: "TPO", devWallet: "abc" })!, /reserved/);
  assert.match(b.refuse({ name: "Something", symbol: "TWIN", devWallet: "abc" })!, /reserved/);
  assert.match(b.refuse({ name: "Fine", symbol: "OK", devWallet: "0x7a521bb15b5bae572460754b05df9856209a6bcf" })!, /banned/);
  b.add({ wallets: ["Byks9wkxQtZSw2d3Wf4Ec1mkxM8hUGibVziryG6o5g91"] });
  const again = new Bans(file);
  assert.ok(again.wallet("byks9wkxqtzsw2d3wf4ec1mkxm8hugibvziryg6o5g91"));
  assert.deepEqual(again.list().names, ["twinpad", "twin"]);
  again.remove({ names: ["twin"] });
  assert.equal(new Bans(file).name("x", "TWIN"), null);
  assert.equal(new Bans(file).name("twinpad x"), "twinpad");
});
