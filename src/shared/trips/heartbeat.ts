export const ABANDONED_TRIP_AFTER_MS = 30 * 60_000;

export function heartbeatIsExpired(now: number, lastHeartbeatAt: number | null, startedAt: number): boolean {
  const reference = lastHeartbeatAt ?? startedAt;
  return Number.isFinite(reference) && now - reference >= ABANDONED_TRIP_AFTER_MS;
}
