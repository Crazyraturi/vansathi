export type LocationFreshness = 'live' | 'delayed' | 'lost';

export function locationFreshness(ageSeconds: number): LocationFreshness {
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return 'lost';
  if (ageSeconds <= 60) return 'live';
  if (ageSeconds <= 180) return 'delayed';
  return 'lost';
}

export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLng = radians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function estimateEtaMinutes(distance: number, speedMetersPerSecond: number): number {
  if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(speedMetersPerSecond) || speedMetersPerSecond < 0) return 2;
  return Math.max(2, Math.ceil(distance / Math.max(speedMetersPerSecond * 3.6, 15) * 60));
}
