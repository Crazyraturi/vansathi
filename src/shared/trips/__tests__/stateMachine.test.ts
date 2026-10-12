import { describe, expect, it } from '@jest/globals';
import { canStartTrip, createTrip, finishTrip, transitionStop } from '../stateMachine';

const fixture = () => createTrip({
  id: 'trip-1', vanId: 'van-1', type: 'morning', startedAt: 100,
  stops: [{ childId: 'child-1', name: 'Asha' }], anotherTripActive: false
});

describe('trip state machine', () => {
  it('rejects starting a second active trip', () => {
    expect(() => createTrip({ id: 'trip-2', vanId: 'van-1', type: 'morning', startedAt: 101, stops: [{ childId: 'child-1', name: 'Asha' }], anotherTripActive: true })).toThrow('trip-already-active');
    expect(canStartTrip(fixture())).toBe(false);
  });

  it('accepts the morning arrival and pickup sequence', () => {
    const arrived = transitionStop(fixture(), 'child-1', 'arrived');
    expect(transitionStop(arrived, 'child-1', 'picked_up').stops[0].status).toBe('picked_up');
  });

  it('rejects pickup before arrival and rejects a wrong-trip action', () => {
    expect(() => transitionStop(fixture(), 'child-1', 'picked_up')).toThrow('illegal-stop-transition');
    const afternoon = createTrip({ id: 'trip-2', vanId: 'van-1', type: 'afternoon', startedAt: 100, stops: [{ childId: 'child-1', name: 'Asha' }], anotherTripActive: false });
    expect(() => transitionStop(afternoon, 'child-1', 'picked_up')).toThrow('illegal-stop-transition');
  });

  it('requires a known stop and keeps terminal stops closed', () => {
    expect(() => transitionStop(fixture(), 'child-2', 'arrived')).toThrow('unknown-stop');
    const absent = transitionStop(fixture(), 'child-1', 'absent');
    expect(() => transitionStop(absent, 'child-1', 'arrived')).toThrow('illegal-stop-transition');
  });

  it('finishes only an active trip with a valid time', () => {
    const completed = finishTrip(fixture(), 200);
    expect(completed.status).toBe('completed');
    expect(completed.endedAt).toBe(200);
    expect(() => finishTrip(fixture(), 99)).toThrow('invalid-trip-time');
    expect(() => finishTrip(completed, 201)).toThrow('trip-not-active');
  });
});
