import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { getAuth } from '@react-native-firebase/auth';
import { getDatabase, ref, set } from '@react-native-firebase/database';
import { enqueueUpload, readActiveTrip, readTrackingNotice, readTrackingRuntime, saveTrackingRuntime, type TrackingNotice, type TrackingRuntime } from './localStore';
import { flushPendingUploads } from './syncQueue';
import { detectTripEvents } from './detection';
import type { TripState } from './stateMachine';

export const LOCATION_TASK_NAME = 'vansathi-active-trip-location';
const MOVING_SPEED_MPS = 0.8;
const MAX_SPEED_MPS = 33.33;
const MAX_ACCURACY_METERS = 50;
const MOVING_INTERVAL_MS = 10_000;
const STATIONARY_INTERVAL_MS = 60_000;
const BREADCRUMB_INTERVAL_MS = 30_000;
const configuredNearRadius = Number(process.env.EXPO_PUBLIC_VAN_NEAR_METERS);
const VAN_NEAR_RADIUS_METERS = Number.isFinite(configuredNearRadius) && configuredNearRadius > 0 ? Math.min(5_000, configuredNearRadius) : 500;

export function locationTaskOptions(mode: TrackingRuntime['mode'], notice: { title: string; body: string; lowBatteryBody: string }, lowBatteryActive = false): Location.LocationTaskOptions {
  return {
    accuracy: mode === 'moving' ? Location.Accuracy.High : Location.Accuracy.Balanced,
    timeInterval: mode === 'moving' ? MOVING_INTERVAL_MS : STATIONARY_INTERVAL_MS,
    distanceInterval: mode === 'moving' ? 20 : 0,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: notice.title,
      notificationBody: lowBatteryActive ? notice.lowBatteryBody : notice.body,
      notificationColor: '#0066CC',
      killServiceOnDestroy: false
    }
  };
}

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLng = radians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function processFix(uid: string, trip: TripState, location: Location.LocationObject): Promise<void> {
  const { vanId, id: tripId } = trip;
  const { latitude, longitude, accuracy, speed, heading } = location.coords;
  const timestamp = Math.floor(location.timestamp);
  if (Date.now() - timestamp > 45_000) return;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracy) ||
    latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || accuracy! < 0 || accuracy! > MAX_ACCURACY_METERS) return;

  let runtime = await readTrackingRuntime(uid);
  if ((await readActiveTrip(uid))?.id !== tripId) return;
  const elapsed = runtime.lastSentAt > 0 ? timestamp - runtime.lastSentAt : 0;
  const moved = runtime.lastSentLat !== null && runtime.lastSentLng !== null
    ? distanceMeters(runtime.lastSentLat, runtime.lastSentLng, latitude, longitude) : Infinity;
  const derivedSpeed = elapsed > 0 && Number.isFinite(moved) ? moved / (elapsed / 1000) : 0;
  const reportedSpeed = typeof speed === 'number' && speed >= 0 ? speed : 0;
  if (reportedSpeed > MAX_SPEED_MPS || derivedSpeed > MAX_SPEED_MPS) return;

  const recentSpeedsMps = [...runtime.recentSpeedsMps, reportedSpeed].slice(-5);
  const averageSpeedMps = recentSpeedsMps.reduce((total, value) => total + value, 0) / Math.max(1, recentSpeedsMps.length);
  const hints = detectTripEvents({ trip, latitude, longitude, averageSpeedMps, alreadyDetected: runtime.detectedEventIds, nearRadiusMeters: VAN_NEAR_RADIUS_METERS });
  for (const hint of hints) {
    try {
      await enqueueUpload(uid, {
        key: `trip-event:${tripId}:${hint.eventId}`, kind: 'trip_event', createdAt: timestamp,
        payload: { tripId, eventId: hint.eventId, eventType: hint.eventType, childId: hint.childId, distanceMeters: hint.distanceMeters, etaMinutes: hint.etaMinutes, occurredAt: timestamp }
      });
      runtime = { ...runtime, detectedEventIds: [...runtime.detectedEventIds, hint.eventId] };
    } catch { /* Keep the hint eligible for another accepted fix when the local queue is full. */ }
  }
  runtime = { ...runtime, recentSpeedsMps };
  await saveTrackingRuntime(uid, runtime);

  const moving = reportedSpeed >= MOVING_SPEED_MPS || moved >= 20;
  const desiredMode: TrackingRuntime['mode'] = moving ? 'moving' : 'stationary';
  const now = Date.now();
  if (runtime.mode !== desiredMode && now - runtime.lastModeChangeAt >= STATIONARY_INTERVAL_MS) {
    runtime = { ...runtime, mode: desiredMode, lastModeChangeAt: now };
    await saveTrackingRuntime(uid, runtime);
    const notice = await readTrackingNotice(uid);
    if (notice) await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, locationTaskOptions(desiredMode, notice, runtime.lowBatteryActive));
  }

  const minimumInterval = moving ? MOVING_INTERVAL_MS : STATIONARY_INTERVAL_MS;
  const movedEnough = runtime.lastSentLat === null || moved >= 20;
  const timeReady = runtime.lastSentAt === 0 || timestamp - runtime.lastSentAt >= minimumInterval;
  const bucketId = String(Math.floor(timestamp / BREADCRUMB_INTERVAL_MS));
  const battery = await Battery.getBatteryLevelAsync();
  const batteryLevel = Number.isFinite(battery) && battery >= 0 ? Math.max(0, Math.min(100, Math.round(battery * 100))) : 100;
  const lowBatteryActive = batteryLevel < 20;
  if (runtime.lowBatteryActive !== lowBatteryActive) {
    runtime = { ...runtime, lowBatteryActive };
    await saveTrackingRuntime(uid, runtime);
    const notice = await readTrackingNotice(uid);
    if (notice) await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, locationTaskOptions(runtime.mode, notice, lowBatteryActive));
    if (lowBatteryActive && notice) {
      await Notifications.scheduleNotificationAsync({ content: { title: notice.title, body: notice.lowBatteryBody }, trigger: null }).catch(() => undefined);
    }
  }
  const position = {
    lat: latitude,
    lng: longitude,
    speed: reportedSpeed,
    heading: typeof heading === 'number' && heading >= 0 && heading < 360 ? heading : 0,
    accuracy: accuracy!,
    timestamp,
    tripId,
    batteryLevel,
    tripActive: true
  };

  if (timeReady && (movedEnough || !moving)) {
    try {
      if ((await readActiveTrip(uid))?.id !== tripId) return;
      await set(ref(getDatabase(), `live/${vanId}`), position);
      runtime = { ...runtime, lastSentAt: timestamp, lastSentLat: latitude, lastSentLng: longitude };
      await saveTrackingRuntime(uid, runtime);
    } catch {
      // A live position is not queued; the next accepted fix replaces it.
    }
  }

  if (timestamp - runtime.lastBreadcrumbAt >= BREADCRUMB_INTERVAL_MS) {
    const point = { lat: latitude, lng: longitude, accuracy: accuracy!, timestamp };
    const key = `breadcrumb:${tripId}:${bucketId}`;
    try {
      if ((await readActiveTrip(uid))?.id !== tripId) return;
      await enqueueUpload(uid, { key, kind: 'breadcrumb', createdAt: timestamp, payload: { tripId, pointId: bucketId, ...point } });
      void flushPendingUploads(uid);
    } catch { return; }
    runtime = { ...runtime, lastBreadcrumbAt: timestamp };
    await saveTrackingRuntime(uid, runtime);
  }
}

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  try {
    const user = getAuth().currentUser;
    if (!user) return;
    const trip = await readActiveTrip(user.uid);
    if (!trip) return;
    void flushPendingUploads(user.uid);
    const fixes = [...data.locations].sort((a, b) => a.timestamp - b.timestamp);
    for (const location of fixes) await processFix(user.uid, trip, location);
  } catch {
    // The task resumes on the next location callback; never persist or log child data here.
  }
});

export async function startTripLocationTask(notice: TrackingNotice): Promise<void> {
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
  if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, locationTaskOptions('moving', notice));
}

export async function stopTripLocationTask(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
}

export async function isTripLocationTaskStarted(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
}
