interface WindowEntry {
  count: number;
  resetAt: number;
}

/** Bounded in-process transport limiter. It intentionally ignores forwarded headers. */
export class RequestRateLimiter {
  private readonly windows = new Map<string, WindowEntry>();
  private checks = 0;

  constructor(
    private readonly maximumRequests = 60,
    private readonly windowMilliseconds = 60_000,
    private readonly maximumClients = 4096,
  ) {}

  allow(clientAddress: string | undefined, nowMilliseconds = Date.now()): boolean {
    const key = clientAddress || 'unknown';
    const current = this.windows.get(key);
    if (current && current.resetAt > nowMilliseconds) {
      if (current.count >= this.maximumRequests) return false;
      current.count += 1;
    } else {
      if (!current && this.windows.size >= this.maximumClients) {
        this.prune(nowMilliseconds);
        if (this.windows.size >= this.maximumClients) return false;
      }
      this.windows.set(key, { count: 1, resetAt: nowMilliseconds + this.windowMilliseconds });
    }

    this.checks += 1;
    if (this.checks % 256 === 0) this.prune(nowMilliseconds);
    return true;
  }

  private prune(nowMilliseconds: number): void {
    for (const [key, value] of this.windows) {
      if (value.resetAt <= nowMilliseconds) this.windows.delete(key);
    }
  }
}
