import { getMessaging, getToken, onTokenRefresh } from '@react-native-firebase/messaging';
import { arrayRemove, doc, runTransaction } from '@react-native-firebase/firestore';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { firestore } from '../firebase/client';

type ActiveRegistration = { token: string; unsubscribe: () => void };
const activeRegistrations = new Map<string, ActiveRegistration>();
const permissionAttempted = new Set<string>();

export async function registerPushNotifications(uid: string, strings: { generalChannel: string; emergencyChannel: string }): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('trip_updates', { name: strings.generalChannel, importance: Notifications.AndroidImportance.HIGH, vibrationPattern: [0, 250, 150, 250] });
    await Notifications.setNotificationChannelAsync('emergency_alerts', { name: strings.emergencyChannel, importance: Notifications.AndroidImportance.MAX, vibrationPattern: [0, 500, 200, 500] });
  }
  if (activeRegistrations.has(uid) || permissionAttempted.has(uid)) return;
  permissionAttempted.add(uid);
  let permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted) permissions = await Notifications.requestPermissionsAsync();
  if (!permissions.granted) return;
  const messaging = getMessaging();
  const token = await getToken(messaging);
  await addToken(uid, token);
  activeRegistrations.get(uid)?.unsubscribe();
  const unsubscribe = onTokenRefresh(messaging, nextToken => { void replaceToken(uid, nextToken); });
  activeRegistrations.set(uid, { token, unsubscribe });
}

async function addToken(uid: string, token: string): Promise<void> {
  await runTransaction(firestore, async transaction => {
    const reference = doc(firestore, 'users', uid);
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) return;
    const tokens = snapshot.get('fcmTokens') as string[] | undefined;
    transaction.update(reference, { fcmTokens: [...new Set([...(tokens ?? []), token])].slice(-20) });
  });
}

async function replaceToken(uid: string, nextToken: string): Promise<void> {
  await runTransaction(firestore, async transaction => {
    const reference = doc(firestore, 'users', uid);
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) return;
    const tokens = (snapshot.get('fcmTokens') as string[] | undefined) ?? [];
    transaction.update(reference, { fcmTokens: [...new Set([...tokens.filter(token => token !== activeRegistrations.get(uid)?.token), nextToken])].slice(-20) });
  });
  const registration = activeRegistrations.get(uid);
  if (registration) activeRegistrations.set(uid, { ...registration, token: nextToken });
}

export async function unregisterPushNotifications(uid: string): Promise<void> {
  const registration = activeRegistrations.get(uid);
  if (!registration) return;
  registration.unsubscribe();
  activeRegistrations.delete(uid);
  try { await runTransaction(firestore, async transaction => {
    const reference = doc(firestore, 'users', uid);
    const snapshot = await transaction.get(reference);
    if (snapshot.exists()) transaction.update(reference, { fcmTokens: arrayRemove(registration.token) });
  }); } catch { /* Token removal is best effort if the session has already expired. */ }
}
