import { describe, expect, test } from '@jest/globals';
import { heartbeatIsExpired } from '../heartbeat';

describe('trip heartbeat expiry', () => {
  test('expires after 30 minutes and falls back to trip start when no location exists', () => {
    expect(heartbeatIsExpired(1_800_000, 0, 0)).toBe(true);
    expect(heartbeatIsExpired(1_799_999, 0, 0)).toBe(false);
    expect(heartbeatIsExpired(1_900_000, null, 100_000)).toBe(true);
  });
});
