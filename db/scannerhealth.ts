/** Pure watchdog rules so boundary cases stay cheap to test. */

export const WATCHDOG_WINDOW_MS = 60 * 60 * 1000;
export const WATCHDOG_FRESH_MS = 20 * 60 * 1000;
export const WATCHDOG_RECOVERY_COOLDOWN_MS = 55 * 60 * 1000;
export const WATCHDOG_ALARM_COOLDOWN_MS = 4 * 60 * 60 * 1000;

export type ScannerHealthSnapshot = {
  active: number;
  recent: number;
  latestChecked: number;
};

export type ScannerHealthDecision = {
  healthy: boolean;
  skipped: boolean;
  covered: number;
  quietForMs: number;
  reason: "healthy" | "no_active_sources" | "no_recent_progress" | "low_hourly_coverage";
};

export function evaluateScannerHealth(
  snapshot: ScannerHealthSnapshot,
  now: number
): ScannerHealthDecision {
  const active = Math.max(0, Math.trunc(snapshot.active));
  const recent = Math.max(0, Math.min(active, Math.trunc(snapshot.recent)));
  const latestChecked = Math.max(0, Number(snapshot.latestChecked) || 0);

  if (!active) {
    return {
      healthy: true,
      skipped: true,
      covered: 100,
      quietForMs: 0,
      reason: "no_active_sources",
    };
  }

  const quietForMs = latestChecked ? Math.max(0, now - latestChecked) : Number.POSITIVE_INFINITY;
  const covered = Math.round((recent / active) * 100);
  if (quietForMs > WATCHDOG_FRESH_MS) {
    return { healthy: false, skipped: false, covered, quietForMs, reason: "no_recent_progress" };
  }
  if (recent * 2 < active) {
    return { healthy: false, skipped: false, covered, quietForMs, reason: "low_hourly_coverage" };
  }
  return { healthy: true, skipped: false, covered, quietForMs, reason: "healthy" };
}
