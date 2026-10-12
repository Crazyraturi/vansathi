import { describe, expect, test } from '@jest/globals';
import { distanceKm, estimateEtaMinutes, locationFreshness } from '../parentLogic';

describe('parent trip display logic', () => {
  test('marks live locations delayed after 60 seconds and lost after three minutes', () => {
    expect(locationFreshness(60)).toBe('live');
    expect(locationFreshness(61)).toBe('delayed');
    expect(locationFreshness(181)).toBe('lost');
    expect(locationFreshness(Number.NaN)).toBe('lost');
  });

  test('estimates ETA with a safe low-speed floor', () => {
    expect(estimateEtaMinutes(1, 0)).toBe(4);
    expect(estimateEtaMinutes(0, 0)).toBe(2);
    expect(estimateEtaMinutes(-1, 0)).toBe(2);
  });

  test('computes distance between a van and the child stop', () => {
    expect(distanceKm(0, 0, 0, 1)).toBeCloseTo(111.2, 0);
    expect(distanceKm(12.9716, 77.5946, 12.9716, 77.5946)).toBe(0);
  });
});
