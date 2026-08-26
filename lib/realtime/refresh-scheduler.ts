/**
 * A small state machine around an expensive route refresh.
 *
 * A debounce only limits a burst before work starts. It does nothing when a
 * second burst arrives while the first server render is still in flight. This
 * scheduler makes that state explicit: one refresh may run, every event during
 * it becomes one dirty bit, and completing it can schedule at most one trailing
 * refresh. A minimum interval prevents a permanently busy queue from turning
 * that trailing refresh into a tight loop.
 */
export const LIVE_REFRESH_COALESCE_MS = 1_000;
export const LIVE_REFRESH_COOLDOWN_MS = 3_000;

type RefreshSchedulerOptions = {
  start: () => void;
  visible?: boolean;
  coalesceMs?: number;
  cooldownMs?: number;
  now?: () => number;
};

export class RefreshScheduler {
  private readonly start: () => void;
  private readonly coalesceMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private dirty = false;
  private running = false;
  private visible: boolean;
  private disposed = false;
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor({
    start,
    visible = true,
    coalesceMs = LIVE_REFRESH_COALESCE_MS,
    cooldownMs = LIVE_REFRESH_COOLDOWN_MS,
    now = Date.now,
  }: RefreshSchedulerOptions) {
    this.start = start;
    this.visible = visible;
    this.coalesceMs = coalesceMs;
    this.cooldownMs = cooldownMs;
    this.now = now;
  }

  request(): void {
    if (this.disposed) return;
    this.dirty = true;
    this.schedule();
  }

  /** Called when React has committed the transition started by this scheduler. */
  complete(): void {
    if (this.disposed || !this.running) return;
    this.running = false;
    this.schedule();
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;

    if (!visible && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (visible) this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
  }

  private schedule(): void {
    if (this.disposed || !this.visible || !this.dirty || this.running || this.timer !== null) {
      return;
    }

    const sinceLastStart = this.now() - this.lastStartedAt;
    const delay = Math.max(this.coalesceMs, this.cooldownMs - sinceLastStart);

    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed || !this.visible || this.running || !this.dirty) return;

      this.dirty = false;
      this.running = true;
      this.lastStartedAt = this.now();

      try {
        this.start();
      } catch (error) {
        // A synchronous router failure must not wedge the gate forever. The
        // caller still owns reporting the error; this only restores liveness.
        this.running = false;
        throw error;
      }
    }, delay);
  }
}
