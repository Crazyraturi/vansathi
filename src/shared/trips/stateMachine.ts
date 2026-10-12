export type TripType = 'morning' | 'afternoon';
export type TripStatus = 'started' | 'completed' | 'cancelled' | 'abandoned';
export type StopStatus = 'pending' | 'arrived' | 'picked_up' | 'dropped' | 'skipped' | 'absent';
export type GeoPoint = { lat: number; lng: number };
export type TripStop = { childId: string; name: string; status: StopStatus; location?: GeoPoint };
export type TripState = {
  id: string;
  vanId: string;
  type: TripType;
  status: TripStatus;
  startedAt: number;
  endedAt: number | null;
  stops: TripStop[];
  schoolLocation?: GeoPoint;
};

export function createTrip(input: { id: string; vanId: string; type: TripType; startedAt: number; stops: (Pick<TripStop, 'childId' | 'name'> & Partial<Pick<TripStop, 'status' | 'location'>> )[]; schoolLocation?: GeoPoint; anotherTripActive: boolean }): TripState {
  if (input.anotherTripActive) throw new Error('trip-already-active');
  if (!input.id || !input.vanId || input.stops.length === 0 || input.stops.some(stop => !stop.childId || !stop.name)) {
    throw new Error('invalid-trip');
  }
  const uniqueChildren = new Set(input.stops.map(stop => stop.childId));
  if (uniqueChildren.size !== input.stops.length) throw new Error('duplicate-stop');
  return { id: input.id, vanId: input.vanId, type: input.type, status: 'started', startedAt: input.startedAt, endedAt: null, schoolLocation: input.schoolLocation, stops: input.stops.map(stop => ({ ...stop, status: stop.status ?? 'pending' })) };
}

export function transitionStop(trip: TripState, childId: string, nextStatus: StopStatus): TripState {
  if (trip.status !== 'started') throw new Error('trip-not-active');
  const index = trip.stops.findIndex(stop => stop.childId === childId);
  if (index < 0) throw new Error('unknown-stop');
  const current = trip.stops[index].status;
  const morning: Record<StopStatus, StopStatus[]> = {
    pending: ['arrived', 'skipped', 'absent'], arrived: ['picked_up', 'absent', 'skipped'],
    picked_up: [], dropped: [], skipped: [], absent: []
  };
  const afternoon: Record<StopStatus, StopStatus[]> = {
    pending: ['arrived', 'skipped'], arrived: ['dropped', 'skipped'],
    picked_up: [], dropped: [], skipped: [], absent: []
  };
  const allowed = trip.type === 'morning' ? morning[current] : afternoon[current];
  if (!allowed.includes(nextStatus)) throw new Error('illegal-stop-transition');
  const stops = [...trip.stops];
  stops[index] = { ...stops[index], status: nextStatus };
  return { ...trip, stops };
}

export function finishTrip(trip: TripState, endedAt: number, cancelled = false): TripState {
  if (trip.status !== 'started') throw new Error('trip-not-active');
  if (endedAt < trip.startedAt) throw new Error('invalid-trip-time');
  return { ...trip, status: cancelled ? 'cancelled' : 'completed', endedAt };
}

export function canStartTrip(activeTrip: TripState | null): boolean {
  return activeTrip === null || activeTrip.status !== 'started';
}
