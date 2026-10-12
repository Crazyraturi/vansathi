import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getPushCopy, getPushText, type PushCopyKind } from '../../src/shared/notifications/catalog';

if (getApps().length === 0) initializeApp();
const db = getFirestore();

function pushKind(event: FirebaseFirestore.DocumentData): PushCopyKind | null {
  if (event.type === 'trip_started' || event.type === 'van_near' || event.type === 'reached_school' ||
    event.type === 'not_picked_up' || event.type === 'emergency' || event.type === 'location_lost') return event.type;
  if (event.type === 'stop_status' && ['picked_up', 'absent', 'dropped'].includes(event.status)) return event.status;
  return null;
}

function enabledForEvent(preferences: Record<string, unknown>, kind: PushCopyKind): boolean {
  if (kind === 'emergency') return preferences.emergencyAlerts !== false;
  if (kind === 'location_lost') return preferences.locationWarnings !== false;
  return preferences.tripUpdates !== false;
}

async function claimReceipt(receiptRef: FirebaseFirestore.DocumentReference): Promise<boolean> {
  return db.runTransaction(async transaction => {
    const receipt = await transaction.get(receiptRef);
    const updatedAt = receipt.get('updatedAt') as FirebaseFirestore.Timestamp | undefined;
    if (receipt.get('status') === 'sent') return false;
    if (receipt.get('status') === 'sending' && updatedAt && Date.now() - updatedAt.toMillis() < 120_000) return false;
    transaction.set(receiptRef, { status: 'sending', updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

export async function notifyParentsForTripEvent(tripId: string, eventId: string): Promise<void> {
  const tripRef = db.collection('trips').doc(tripId);
  const eventRef = tripRef.collection('events').doc(eventId);
  const [tripSnapshot, eventSnapshot] = await Promise.all([tripRef.get(), eventRef.get()]);
  if (!tripSnapshot.exists || !eventSnapshot.exists) return;
  const event = eventSnapshot.data()!;
  const kind = pushKind(event);
  if (!kind) return;
  const trip = tripSnapshot.data()!;
  const vanSnapshot = await db.collection('vans').doc(trip.vanId as string).get();
  const van = vanSnapshot.data() ?? {};
  const childSnapshot = typeof event.childId === 'string'
    ? await db.collection('children').doc(event.childId).get()
    : null;
  const affectedChildren = childSnapshot?.exists
    ? [childSnapshot]
    : (await db.collection('children').where('vanId', '==', trip.vanId).get()).docs;
  const parentIds = [...new Set(affectedChildren.map(child => child.get('parentUid')).filter((uid): uid is string => typeof uid === 'string'))];
  const messaging = getMessaging();
  const variables = {
    tripType: trip.type as string,
    childName: childSnapshot?.get('name') as string ?? '',
    eta: typeof event.etaMinutes === 'number' ? event.etaMinutes : 2
  };

  for (const parentId of parentIds) {
    const userRef = db.collection('users').doc(parentId);
    const user = await userRef.get();
    const preferences = user.get('notificationPreferences') as Record<string, unknown> | undefined ?? {};
    if (user.get('role') !== 'parent' || !enabledForEvent(preferences, kind)) continue;
    const language = userLanguage(user);
    const tokens = [...new Set((user.get('fcmTokens') as unknown[] | undefined ?? []).filter((token): token is string => typeof token === 'string' && token.length > 0))];
    const receiptRef = eventRef.collection('notificationReceipts').doc(parentId);
    if (!(await claimReceipt(receiptRef))) continue;
    try {
      let sent = tokens.length === 0;
      const invalidTokens: string[] = [];
      for (let index = 0; index < tokens.length; index += 500) {
        const batch = tokens.slice(index, index + 500);
        const copy = getPushCopy(language, kind, {
          ...variables,
          tripType: getPushText(language, `tripType_${trip.type}`),
          vanName: typeof van.name === 'string' ? van.name : typeof van.number === 'string' ? van.number : getPushText(language, 'push_default_van')
        });
        const response = await messaging.sendEachForMulticast({
          tokens: batch,
          notification: copy,
          data: {
            tripId, vanId: trip.vanId as string, eventId, eventType: kind,
            childId: typeof event.childId === 'string' ? event.childId : ''
          },
          android: { priority: kind === 'emergency' ? 'high' : 'normal', notification: { channelId: kind === 'emergency' ? 'emergency_alerts' : 'trip_updates', sound: 'default' } },
          apns: { payload: { aps: { sound: 'default' } } }
        });
        sent ||= response.successCount > 0;
        response.responses.forEach((result, tokenIndex) => {
          const code = result.error?.code;
          if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') invalidTokens.push(batch[tokenIndex]);
        });
      }
      if (invalidTokens.length) await userRef.update({ fcmTokens: FieldValue.arrayRemove(...invalidTokens) });
      if (!sent) throw new Error('push-send-failed');
      await receiptRef.set({ status: 'sent', updatedAt: FieldValue.serverTimestamp() });
    } catch (error) {
      await receiptRef.set({ status: 'failed', updatedAt: FieldValue.serverTimestamp() });
      throw error;
    }
  }
}

function userLanguage(user: FirebaseFirestore.DocumentSnapshot): 'en' | 'hi' {
  return user.get('language') === 'hi' ? 'hi' : 'en';
}
