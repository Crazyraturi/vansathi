import { httpsCallable } from '@react-native-firebase/functions';
import { doc, setDoc } from '@react-native-firebase/firestore';
import { getNetworkStateAsync } from 'expo-network';
import { firestore, functions } from '../firebase/client';
import { clearActiveTrip, pendingUploads, removePendingUpload, type QueueItem } from './localStore';

const flushByUser = new Map<string, Promise<void>>();

async function upload(item: QueueItem, uid: string): Promise<void> {
  if (item.kind === 'stop_action') {
    const call = httpsCallable(functions, 'recordStopAction');
    await call(item.payload);
  } else if (item.kind === 'trip_event') {
    const call = httpsCallable(functions, 'recordTripEvent');
    await call(item.payload);
  } else if (item.kind === 'breadcrumb') {
    const { tripId, pointId, ...point } = item.payload;
    if (typeof tripId !== 'string' || typeof pointId !== 'string') throw new Error('invalid-breadcrumb');
    await setDoc(doc(firestore, 'tripPaths', tripId, 'points', pointId), point);
  } else {
    const call = httpsCallable(functions, 'endTrip');
    await call(item.payload);
    await clearActiveTrip(uid);
  }
}

export function flushPendingUploads(uid: string): Promise<void> {
  const active = flushByUser.get(uid);
  if (active) return active;
  const task = (async () => {
    try {
      const network = await getNetworkStateAsync();
      if (network.isConnected !== true || network.isInternetReachable !== true) return;
      while (true) {
        const batch = await pendingUploads(uid, 40);
        if (!batch.length) return;
        for (const row of batch) {
          try {
          await upload(row.item, uid);
          await removePendingUpload(uid, row.sequence);
          } catch {
            return;
          }
        }
      }
    } catch { return; }
  })();
  flushByUser.set(uid, task);
  return task.finally(() => { flushByUser.delete(uid); });
}
