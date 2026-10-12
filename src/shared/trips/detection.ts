import type { TripState } from './stateMachine';

export type DetectedTripEvent = {
  eventId: string;
  eventType: 'van_near' | 'reached_school';
  childId?: string;
  distanceMeters?: number;
  etaMinutes?: number;
};

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLng = radians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function detectTripEvents(input: {
  trip: TripState;
  latitude: number;
  longitude: number;
  averageSpeedMps: number;
  alreadyDetected: string[];
  nearRadiusMeters?: number;
}): DetectedTripEvent[] {
  const events: DetectedTripEvent[] = [];
  const emitted = new Set(input.alreadyDetected);
  const nextStop = input.trip.stops.find(stop => !['picked_up', 'dropped', 'skipped', 'absent'].includes(stop.status));
  if (nextStop?.location) {
    const distanceMeters = haversineMeters(input.latitude, input.longitude, nextStop.location.lat, nextStop.location.lng);
    const eventId = `van_near_${nextStop.childId}`;
    if (distanceMeters <= (input.nearRadiusMeters ?? 500) && !emitted.has(eventId)) {
      const averageKmh = Math.max(15, input.averageSpeedMps * 3.6);
      events.push({ eventId, eventType: 'van_near', childId: nextStop.childId, distanceMeters: Math.round(distanceMeters), etaMinutes: Math.max(2, Math.ceil(distanceMeters / 1000 / averageKmh * 60)) });
    }
  }
  if (input.trip.type === 'morning' && input.trip.schoolLocation) {
    const distanceMeters = haversineMeters(input.latitude, input.longitude, input.trip.schoolLocation.lat, input.trip.schoolLocation.lng);
    const eventId = 'reached_school';
    if (distanceMeters <= 150 && !emitted.has(eventId)) events.push({ eventId, eventType: 'reached_school', distanceMeters: Math.round(distanceMeters) });
  }
  return events;
}
