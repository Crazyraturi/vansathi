import { describe, expect, test } from '@jest/globals';
import { createTrip } from '../stateMachine';
import { detectTripEvents } from '../detection';

describe('trip geofence hints', () => {
  const trip = createTrip({ id: 'trip-1', vanId: 'van-1', type: 'morning', startedAt: 100, anotherTripActive: false,
    schoolLocation: { lat: 13, lng: 77.6 },
    stops: [{ childId: 'child-1', name: 'A', location: { lat: 12.9716, lng: 77.5946 } }, { childId: 'child-2', name: 'B', location: { lat: 13, lng: 77.6 } }] });

  test('emits one van-near event for the next stop and a rough ETA', () => {
    const events = detectTripEvents({ trip, latitude: 12.9716, longitude: 77.5946, averageSpeedMps: 0, alreadyDetected: [] });
    expect(events).toEqual([{ eventId: 'van_near_child-1', eventType: 'van_near', childId: 'child-1', distanceMeters: 0, etaMinutes: 2 }]);
  });

  test('does not repeat a stop hint and reaches school only on morning trips', () => {
    expect(detectTripEvents({ trip, latitude: 12.9716, longitude: 77.5946, averageSpeedMps: 4, alreadyDetected: ['van_near_child-1'] })).toEqual([]);
    const afternoon = { ...trip, type: 'afternoon' as const };
    expect(detectTripEvents({ trip: afternoon, latitude: 12.972, longitude: 77.594, averageSpeedMps: 3, alreadyDetected: [] }).some(event => event.eventType === 'reached_school')).toBe(false);
  });

  test('emits the school event within 150 m and once per trip', () => {
    expect(detectTripEvents({ trip, latitude: 13, longitude: 77.6, averageSpeedMps: 3, alreadyDetected: [] }).map(event => event.eventType)).toContain('reached_school');
    expect(detectTripEvents({ trip, latitude: 13, longitude: 77.6, averageSpeedMps: 3, alreadyDetected: ['reached_school'] }).map(event => event.eventType)).not.toContain('reached_school');
  });
});
