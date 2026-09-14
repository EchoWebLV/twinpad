import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { LaunchKeys, LaunchRecord, LaunchStatus } from "./record.js";

/** File-backed registry: DATA_DIR/launches/<id>/{record.json,keys.json,image.png}. Records stay in memory. */
export class Registry {
  private records = new Map<string, LaunchRecord>();
  readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "launches");
    fs.mkdirSync(this.root, { recursive: true });
    for (const id of fs.readdirSync(this.root)) {
      const f = path.join(this.root, id, "record.json");
      if (fs.existsSync(f)) this.records.set(id, JSON.parse(fs.readFileSync(f, "utf8")) as LaunchRecord);
    }
  }

  dir(id: string) {
    return path.join(this.root, id);
  }

  newId(symbol: string): string {
    const base = symbol.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "coin";
    for (;;) {
      const id = `${base}-${crypto.randomBytes(3).toString("hex").slice(0, 4)}`;
      if (!this.records.has(id)) return id;
    }
  }

  get(id: string): LaunchRecord | undefined {
    return this.records.get(id);
  }

  list(filter: { status?: LaunchStatus[] } = {}): LaunchRecord[] {
    return [...this.records.values()]
      .filter((r) => !filter.status || filter.status.includes(r.status))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  save(rec: LaunchRecord) {
    this.records.set(rec.id, rec);
    fs.mkdirSync(this.dir(rec.id), { recursive: true });
    atomicWrite(path.join(this.dir(rec.id), "record.json"), JSON.stringify(rec, null, 2), 0o644);
  }

  saveKeys(id: string, keys: LaunchKeys) {
    fs.mkdirSync(this.dir(id), { recursive: true });
    atomicWrite(path.join(this.dir(id), "keys.json"), JSON.stringify(keys), 0o600);
  }

  keys(id: string): LaunchKeys {
    return JSON.parse(fs.readFileSync(path.join(this.dir(id), "keys.json"), "utf8")) as LaunchKeys;
  }

  imagePath(id: string) {
    return path.join(this.dir(id), "image.png");
  }
}

function atomicWrite(file: string, data: string, mode: number) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
}
