import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import type { TripState } from './stateMachine';

export type QueueKind = 'stop_action' | 'breadcrumb' | 'finish_trip' | 'trip_event';
export type QueueItem = { key: string; kind: QueueKind; createdAt: number; payload: Record<string, unknown> };
export type TrackingRuntime = {
  lastSentAt: number;
  lastSentLat: number | null;
  lastSentLng: number | null;
  lastBreadcrumbAt: number;
  mode: 'moving' | 'stationary';
  lastModeChangeAt: number;
  lowBatteryActive: boolean;
  detectedEventIds: string[];
  recentSpeedsMps: number[];
};
export type TrackingNotice = { title: string; body: string; lowBatteryBody: string };

const MAX_QUEUE_SIZE = 500;
const dbCache = new Map<string, Promise<SQLite.SQLiteDatabase>>();
const activePointerKey = (uid: string) => `vansathi.activeTrip.${uid}`;
const dbKeyName = (uid: string) => `vansathi.tripDbKey.${uid}`;

function randomHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function databaseFor(uid: string): Promise<SQLite.SQLiteDatabase> {
  const cached = dbCache.get(uid);
  if (cached) return cached;
  const pending = (async () => {
    let key = await SecureStore.getItemAsync(dbKeyName(uid));
    if (!key) {
      key = randomHex(await Crypto.getRandomBytesAsync(32));
      await SecureStore.setItemAsync(dbKeyName(uid), key, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
    }
    const database = await SQLite.openDatabaseAsync(`vansathi-trip-${uid}.db`);
    await database.execAsync(`PRAGMA key = "x'${key}'"`);
    await database.execAsync('PRAGMA journal_mode = WAL');
    await database.execAsync('CREATE TABLE IF NOT EXISTS local_state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
    await database.execAsync('CREATE TABLE IF NOT EXISTS pending_uploads (sequence INTEGER PRIMARY KEY AUTOINCREMENT, item_key TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL)');
    await database.execAsync('CREATE INDEX IF NOT EXISTS pending_uploads_order ON pending_uploads(sequence)');
    return database;
  })();
  dbCache.set(uid, pending);
  try { return await pending; } catch (error) { dbCache.delete(uid); throw error; }
}

export async function saveActiveTrip(uid: string, trip: TripState): Promise<void> {
  const database = await databaseFor(uid);
  await database.runAsync('INSERT OR REPLACE INTO local_state (key, value) VALUES (?, ?)', 'active_trip', JSON.stringify(trip));
  await SecureStore.setItemAsync(activePointerKey(uid), trip.id, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
}

export async function readActiveTrip(uid: string): Promise<TripState | null> {
  const pointer = await SecureStore.getItemAsync(activePointerKey(uid));
  if (!pointer) return null;
  const database = await databaseFor(uid);
  const row = await database.getFirstAsync<{ value: string }>('SELECT value FROM local_state WHERE key = ?', 'active_trip');
  if (!row) return null;
  try {
    const trip = JSON.parse(row.value) as TripState;
    return trip.id === pointer && trip.status === 'started' ? trip : null;
  } catch { return null; }
}

export async function clearActiveTrip(uid: string): Promise<void> {
  const database = await databaseFor(uid);
  await database.runAsync('DELETE FROM local_state WHERE key = ?', 'active_trip');
  await SecureStore.deleteItemAsync(activePointerKey(uid));
  await database.runAsync('DELETE FROM local_state WHERE key = ?', 'tracking_runtime');
}

export async function readTrackingRuntime(uid: string): Promise<TrackingRuntime> {
  const database = await databaseFor(uid);
  const row = await database.getFirstAsync<{ value: string }>('SELECT value FROM local_state WHERE key = ?', 'tracking_runtime');
  if (row) {
    try {
      const saved = JSON.parse(row.value) as Partial<TrackingRuntime>;
      return { lastSentAt: saved.lastSentAt ?? 0, lastSentLat: saved.lastSentLat ?? null, lastSentLng: saved.lastSentLng ?? null,
        lastBreadcrumbAt: saved.lastBreadcrumbAt ?? 0, mode: saved.mode ?? 'moving', lastModeChangeAt: saved.lastModeChangeAt ?? 0,
        lowBatteryActive: saved.lowBatteryActive ?? false, detectedEventIds: saved.detectedEventIds ?? [], recentSpeedsMps: saved.recentSpeedsMps ?? [] };
    } catch { /* Reset an unreadable local checkpoint. */ }
  }
  return { lastSentAt: 0, lastSentLat: null, lastSentLng: null, lastBreadcrumbAt: 0, mode: 'moving', lastModeChangeAt: 0, lowBatteryActive: false, detectedEventIds: [], recentSpeedsMps: [] };
}

export async function saveTrackingRuntime(uid: string, runtime: TrackingRuntime): Promise<void> {
  const database = await databaseFor(uid);
  await database.runAsync('INSERT OR REPLACE INTO local_state (key, value) VALUES (?, ?)', 'tracking_runtime', JSON.stringify(runtime));
}

export async function enqueueUpload(uid: string, item: QueueItem): Promise<boolean> {
  const database = await databaseFor(uid);
  let queued = true;
  await database.withTransactionAsync(async () => {
    const tripId = item.payload.tripId;
    if (item.kind !== 'finish_trip' && typeof tripId === 'string') {
      const ended = await database.getFirstAsync<{ item_key: string }>('SELECT item_key FROM pending_uploads WHERE item_key = ?', `finish:${tripId}`);
      if (ended) {
        if (item.kind === 'breadcrumb') { queued = false; return; }
        throw new Error('trip-already-finished');
      }
    }
    const countRow = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM pending_uploads');
    if ((countRow?.count ?? 0) >= MAX_QUEUE_SIZE) {
      if (item.kind === 'breadcrumb') { queued = false; return; }
      await database.runAsync("DELETE FROM pending_uploads WHERE sequence = (SELECT sequence FROM pending_uploads WHERE kind = 'breadcrumb' ORDER BY sequence LIMIT 1)");
      const nextCount = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM pending_uploads');
      if ((nextCount?.count ?? 0) >= MAX_QUEUE_SIZE) throw new Error('offline-queue-full');
    }
    await database.runAsync('INSERT OR IGNORE INTO pending_uploads (item_key, kind, created_at, payload) VALUES (?, ?, ?, ?)', item.key, item.kind, item.createdAt, JSON.stringify(item.payload));
  });
  return queued;
}

type QueueRow = { item_key: string; kind: QueueKind; created_at: number; payload: string };
export async function pendingUploads(uid: string, limit = 100): Promise<{ item: QueueItem; sequence: number }[]> {
  const database = await databaseFor(uid);
  const rows = await database.getAllAsync<QueueRow & { sequence: number }>('SELECT sequence, item_key, kind, created_at, payload FROM pending_uploads ORDER BY sequence LIMIT ?', limit);
  return rows.map(row => ({ sequence: row.sequence, item: { key: row.item_key, kind: row.kind, createdAt: row.created_at, payload: JSON.parse(row.payload) as Record<string, unknown> } }));
}

export async function removePendingUpload(uid: string, sequence: number): Promise<void> {
  const database = await databaseFor(uid);
  await database.runAsync('DELETE FROM pending_uploads WHERE sequence = ?', sequence);
}

export async function pendingUploadCount(uid: string): Promise<number> {
  const database = await databaseFor(uid);
  const row = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM pending_uploads');
  return row?.count ?? 0;
}

export async function saveTrackingNotice(uid: string, notice: TrackingNotice): Promise<void> {
  await SecureStore.setItemAsync(`vansathi.trackNotice.${uid}`, JSON.stringify(notice), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
}

export async function readTrackingNotice(uid: string): Promise<TrackingNotice | null> {
  const raw = await SecureStore.getItemAsync(`vansathi.trackNotice.${uid}`);
  if (!raw) return null;
  try {
    const notice = JSON.parse(raw) as Partial<TrackingNotice>;
    return typeof notice.title === 'string' && typeof notice.body === 'string' && typeof notice.lowBatteryBody === 'string'
      ? notice as TrackingNotice : null;
  } catch { return null; }
}
