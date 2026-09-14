import type { Registry } from "./registry.js";
import { transition, type LaunchRecord } from "./record.js";

export type Action = { type: "approve"; id: string } | { type: "launch"; id: string } | { type: "retry"; id: string };
export interface PlanConfig {
  autoApprove: boolean; maxLiveMakers: number;
  /** Failed launches are re-queued up to this many times, after retryBackoffMs since the failure. */
  autoRetries?: number; retryBackoffMs?: number;
  /** Circuit breaker: nothing is approved, retried or launched while paused. */
  paused?: boolean;
}

/** When a failed record failed (its last status step). */
export function failedAt(r: LaunchRecord): number {
  for (let i = r.launch.steps.length - 1; i >= 0; i--) if (r.launch.steps[i].name === "status:failed") return r.launch.steps[i].at;
  return r.createdAt;
}

/** Pure: given all records, what to do now. Approves paid records (auto mode), re-queues failed launches, picks one launch. */
export function plan(records: LaunchRecord[], cfg: PlanConfig, now = Date.now()): Action[] {
  const acts: Action[] = [];
  if (cfg.paused) return acts;
  for (const r of records.filter((r) => r.status === "failed")) {
    if (r.launch.retries < (cfg.autoRetries ?? 0) && now - failedAt(r) >= (cfg.retryBackoffMs ?? 0)) acts.push({ type: "retry", id: r.id });
  }
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

/** Re-queue a failed launch: back to approved with the retry counted. */
export function retry(rec: LaunchRecord, now: number) {
  rec.launch.retries++;
  transition(rec, "approved", now, { retry: rec.launch.retries });
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

  pause(reason: string) {
    this.cfg.paused = true;
    console.error(`[scheduler] PAUSED: ${reason}`);
  }

  unpause() {
    this.cfg.paused = false;
  }

  get paused() {
    return !!this.cfg.paused;
  }

  async tick(now = Date.now()) {
    if (this.running) return;
    this.running = true;
    try {
      for (const a of plan(this.registry.list(), this.cfg, now)) {
        const rec = this.registry.get(a.id)!;
        if (a.type === "approve") {
          approve(rec, now, true);
          this.registry.save(rec);
        } else if (a.type === "retry") {
          retry(rec, now);
          this.registry.save(rec);
          console.log(`[scheduler] auto-retry ${rec.id} (${rec.launch.retries})`);
        } else {
          await this.launch(rec);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
