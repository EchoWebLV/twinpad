import type { Registry } from "./registry.js";
import { transition, type LaunchRecord } from "./record.js";

export type Action = { type: "approve"; id: string } | { type: "launch"; id: string };
export interface PlanConfig { autoApprove: boolean; maxLiveMakers: number }

/** Pure: given all records, what to do now. Approves paid records (auto mode) and picks one launch. */
export function plan(records: LaunchRecord[], cfg: PlanConfig): Action[] {
  const acts: Action[] = [];
  const busy = records.filter((r) => ["live", "launching", "approved"].includes(r.status)).length;
  let slots = cfg.maxLiveMakers - busy;
  const approved = records.filter((r) => r.status === "approved");
  if (cfg.autoApprove) {
    for (const r of records.filter((r) => r.status === "paid").sort((a, b) => a.createdAt - b.createdAt)) {
      if (slots <= 0) break;
      acts.push({ type: "approve", id: r.id });
      approved.push(r);
      slots--;
    }
  }
  const launching = records.some((r) => r.status === "launching");
  if (!launching && approved.length) acts.push({ type: "launch", id: approved.sort((a, b) => a.createdAt - b.createdAt)[0].id });
  return acts;
}

export function approve(rec: LaunchRecord, now: number, auto: boolean, note: string | null = null) {
  rec.approval = { status: "approved", at: now, note, auto };
  transition(rec, "approved", now);
}

export function reject(rec: LaunchRecord, now: number, note: string | null) {
  rec.approval = { status: "rejected", at: now, note, auto: false };
  transition(rec, "rejected", now);
}

/** Every `intervalMs`: plan, apply approvals, start at most one launch (awaited, so launches are serial). */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(
    private registry: Registry,
    private cfg: PlanConfig,
    private launch: (rec: LaunchRecord) => Promise<void>,
    private intervalMs = 30_000,
  ) {}

  start() {
    const loop = async () => {
      await this.tick().catch((e) => console.error("[scheduler]", (e as Error).message));
      this.timer = setTimeout(loop, this.intervalMs);
    };
    void loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  async tick(now = Date.now()) {
    if (this.running) return;
    this.running = true;
    try {
      for (const a of plan(this.registry.list(), this.cfg)) {
        const rec = this.registry.get(a.id)!;
        if (a.type === "approve") {
          approve(rec, now, true);
          this.registry.save(rec);
        } else {
          await this.launch(rec);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
