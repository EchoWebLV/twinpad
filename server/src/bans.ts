import fs from "node:fs";
import path from "node:path";

/**
 * Wallets and names the pad refuses. Persisted in DATA_DIR/bans.json so an admin ban survives restarts;
 * BANNED_WALLETS / BANNED_NAMES from the environment are folded in at boot.
 * Names match case-insensitively as substrings of the token name or symbol ("twinpad" bans "TwinPad Official").
 */
export interface BanList { wallets: string[]; names: string[] }

export class Bans {
  private wallets = new Set<string>();
  private names: string[] = [];
  constructor(private file: string | null, seed: Partial<BanList> = {}) {
    if (file && fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BanList>;
      this.add(j);
    }
    this.add(seed);
  }

  static fromEnv(v: string | undefined): string[] {
    return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  }

  list(): BanList {
    return { wallets: [...this.wallets], names: [...this.names] };
  }

  /** Adds (idempotent) and persists. Returns what is now banned. */
  add(b: Partial<BanList>): BanList {
    for (const w of b.wallets ?? []) if (w.trim()) this.wallets.add(w.trim().toLowerCase());
    for (const n of b.names ?? []) {
      const k = n.trim().toLowerCase();
      if (k && !this.names.includes(k)) this.names.push(k);
    }
    this.save();
    return this.list();
  }

  remove(b: Partial<BanList>): BanList {
    for (const w of b.wallets ?? []) this.wallets.delete(w.trim().toLowerCase());
    const drop = new Set((b.names ?? []).map((n) => n.trim().toLowerCase()));
    this.names = this.names.filter((n) => !drop.has(n));
    this.save();
    return this.list();
  }

  wallet(addr: string | null | undefined): boolean {
    return !!addr && this.wallets.has(addr.trim().toLowerCase());
  }

  /** The banned name that matches, or null. */
  name(name: string, symbol = ""): string | null {
    const n = name.toLowerCase(), s = symbol.toLowerCase();
    return this.names.find((k) => n.includes(k) || s.includes(k)) ?? null;
  }

  /** Why a launch request is refused, or null when it may go ahead. */
  refuse(i: { name: string; symbol: string; devWallet: string }): string | null {
    if (this.wallet(i.devWallet)) return "this wallet is banned from launching here";
    const n = this.name(i.name, i.symbol);
    if (n) return `"${n}" is reserved; pick another name`;
    return null;
  }

  private save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.list(), null, 2));
    fs.renameSync(tmp, this.file);
  }
}
