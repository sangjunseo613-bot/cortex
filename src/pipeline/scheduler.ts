import { App, Notice } from "obsidian";
import { latestSnapshot } from "./diagnostics";

/**
 * Scheduler — opt-in periodic diagnostic.
 *
 * Strategy:
 *   - On plugin load, check if a week (or more) has passed since the latest
 *     snapshot. If so, queue a run for ~30s after load (avoid blocking startup).
 *   - Then setInterval(daily) — every 24h check whether a new week has started
 *     since last snapshot. If yes, run.
 *
 * Why daily polling rather than weekly setTimeout: Obsidian sessions span
 * irregular intervals. A naive 7-day setTimeout fires only if Obsidian was
 * left running. Daily polling lets us catch up after the user comes back.
 *
 * Costs: 1 graph build + 1 discovery (with LLM) per week. Roughly 30s + ~10
 * Codex calls. Configurable via settings — user can disable entirely.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface SchedulerCallbacks {
  /** Called when a periodic snapshot is due. Implement = the actual work. */
  runWeeklyDiagnostic: () => Promise<void>;
}

export class WeeklyScheduler {
  private timer: number | null = null;
  private startupTimer: number | null = null;
  private enabled = false;

  constructor(
    private app: App,
    private callbacks: SchedulerCallbacks,
  ) {}

  async start(): Promise<void> {
    if (this.enabled) return;
    this.enabled = true;

    // Catch-up check: if last snapshot is older than 7 days (or absent),
    // queue a run shortly after load so the user sees fresh data.
    const last = await latestSnapshot(this.app);
    const now = Date.now();
    const overdue = !last || now - last.ts > WEEK_MS;

    if (overdue) {
      this.startupTimer = window.setTimeout(() => {
        this.startupTimer = null;
        void this.runIfDue();
      }, 30_000); // 30s grace after plugin load
    }

    // Daily interval — cheap check that fires only if a new week is due.
    this.timer = window.setInterval(() => {
      void this.runIfDue();
    }, DAY_MS);
  }

  stop(): void {
    this.enabled = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.startupTimer !== null) {
      window.clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Run the weekly diagnostic if the previous snapshot is older than a week.
   * Otherwise no-op silently. Public so the user can trigger via command too.
   */
  async runIfDue(): Promise<boolean> {
    const last = await latestSnapshot(this.app);
    const now = Date.now();
    if (last && now - last.ts < WEEK_MS) {
      return false;
    }
    try {
      await this.callbacks.runWeeklyDiagnostic();
      return true;
    } catch (err) {
      console.error("[cortex] scheduled diagnostic failed:", err);
      new Notice(
        `Cortex 자동 진단 실패: ${err instanceof Error ? err.message : String(err)}`,
        10000,
      );
      return false;
    }
  }
}
