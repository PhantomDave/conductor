import type { HealthcheckConfig } from "../config/schema";
import { probeOnce } from "../executor/healthcheck";

export interface HealthMonitorOptions {
  intervalMs?: number;
}

/** Fired on each health-flip with the new state and the probe detail (e.g. "port 8080"). */
export type HealthFlipHandler = (isHealthy: boolean, detail: string) => void;

/**
 * Periodically re-runs a health probe so running services that go unhealthy
 * (crash/restart, OOM killer, etc.) are detected without manual restart.
 */
export class HealthMonitor {
  private intervalId?: ReturnType<typeof setInterval>;
  private lastHealthy: boolean | undefined = undefined;

  constructor(
    /** Command healthcheck config to repeatedly probe */
    private readonly healthcheck: HealthcheckConfig,
    /** Environment used to resolve variables in the healthcheck URL/command */
    private readonly getEnv: () => Record<string, string>,
    /** Called on each health-flip with (isHealthy, detail) — must update wrapper state + emit logs */
    private readonly onHealthFlip: HealthFlipHandler,
    /** Options (default 5000ms interval = same as configured interval_ms) */
    private options: HealthMonitorOptions = {},
  ) {}

  start(): void {
    const intervalMs = this.options.intervalMs ?? this.healthcheck?.interval_ms ?? 5000;
    if (intervalMs < 1000 || !this.healthcheck) return;

    this.intervalId = setInterval(async () => {
      try {
        const result = await probeOnce(this.healthcheck, this.getEnv());

        // Only flip state on changes to avoid unnecessary noise
        const isHealthy = result.ok;
        if (isHealthy !== this.lastHealthy) {
          this.lastHealthy = isHealthy;
          this.onHealthFlip(isHealthy, result.detail);
        }
      } catch {
        // probeOnce should always return. If it throws, keep previous state.
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }
}
