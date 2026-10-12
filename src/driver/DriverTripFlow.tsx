import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { collection, doc, getDoc, getDocs, query, where } from '@react-native-firebase/firestore';
import { onValue, ref } from '@react-native-firebase/database';
import { httpsCallable } from '@react-native-firebase/functions';
import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { addNetworkStateListener, getNetworkStateAsync } from 'expo-network';
import { auth, firestore, functions, realtime } from '../shared/firebase/client';
import { Button } from '../shared/ui/Button';
import { Card } from '../shared/ui/Card';
import { colors, spacing, type } from '../shared/theme/tokens';
import { createTrip, finishTrip, transitionStop, type StopStatus, type TripState, type TripType } from '../shared/trips/stateMachine';
import { clearActiveTrip, enqueueUpload, pendingUploadCount, readActiveTrip, saveActiveTrip, saveTrackingNotice } from '../shared/trips/localStore';
import { flushPendingUploads } from '../shared/trips/syncQueue';
import { isTripLocationTaskStarted, startTripLocationTask, stopTripLocationTask } from '../shared/trips/locationTask';

type LiveState = { timestamp?: number; accuracy?: number; batteryLevel?: number; tripActive?: boolean } | null;
type StartResponse = { tripId: string; vanId: string; type: TripType; startedAt: number; stops: { childId: string; name: string; status: StopStatus; location: { lat: number; lng: number } }[]; schoolLocation: { lat: number; lng: number } };

function eventTime(): number { return Date.now(); }

export function DriverTripFlow({ vanId, onOpenHealth }: { vanId: string | null; onOpenHealth: () => void }) {
  const { t, i18n } = useTranslation();
  const [trip, setTrip] = useState<TripState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState>(null);
  const [connected, setConnected] = useState(false);
  const [battery, setBattery] = useState<number | null>(null);
  const [queued, setQueued] = useState(0);
  const [criticalReady, setCriticalReady] = useState(false);
  const [notificationsAllowed, setNotificationsAllowed] = useState(false);
  const [clockNow, setClockNow] = useState(0);
  const uid = auth.currentUser?.uid;

  const refreshQueue = useCallback(async () => {
    if (uid) setQueued(await pendingUploadCount(uid));
  }, [uid]);

  const refreshReadiness = useCallback(async () => {
    try {
      const foreground = await Location.getForegroundPermissionsAsync();
      const background = await Location.getBackgroundPermissionsAsync();
      const providers = await Location.getProviderStatusAsync();
      const notification = await Notifications.getPermissionsAsync();
      const network = await getNetworkStateAsync();
      const precise = LocationAccuracyIsPrecise(foreground);
      setCriticalReady(foreground.granted && background.granted && precise && providers.locationServicesEnabled && (providers.gpsAvailable !== false));
      setNotificationsAllowed(notification.granted);
      setConnected(network.isConnected === true && network.isInternetReachable === true);
      return foreground.granted && background.granted && precise && providers.locationServicesEnabled && (providers.gpsAvailable !== false);
    } catch { setCriticalReady(false); setNotificationsAllowed(false); setConnected(false); return false; }
  }, []);

  const recoverServerTrip = useCallback(async (): Promise<TripState | null> => {
    if (!vanId || !uid) return null;
    const vanSnapshot = await getDoc(doc(firestore, 'vans', vanId));
    const activeTripId = vanSnapshot.get('activeTripId');
    if (typeof activeTripId !== 'string') return null;
    const snapshot = await getDoc(doc(firestore, 'trips', activeTripId));
    if (!snapshot.exists() || snapshot.get('status') !== 'started') return null;
    const data = snapshot.data()!;
    const timestamp = data.startedAt as { toMillis?: () => number } | number;
    const children = await getDocs(query(collection(firestore, 'children'), where('vanId', '==', vanId)));
    const childLocations = new Map(children.docs.map(child => [child.id, child.get('homeLocation') as { lat: number; lng: number }]));
    const school = vanSnapshot.get('school') as { lat?: number; lng?: number } | undefined;
    const recovered: TripState = {
      id: snapshot.id,
      vanId: data.vanId as string,
      type: data.type as TripType,
      status: 'started',
      startedAt: typeof timestamp === 'number' ? timestamp : timestamp.toMillis?.() ?? 0,
      endedAt: null,
      stops: (data.stops as TripState['stops']).map(stop => ({ ...stop, location: childLocations.get(stop.childId) })),
      schoolLocation: typeof school?.lat === 'number' && typeof school.lng === 'number' ? { lat: school.lat, lng: school.lng } : undefined
    };
    await saveActiveTrip(uid, recovered);
    return recovered;
  }, [vanId, uid]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!uid) { setLoading(false); return; }
      try {
        await refreshReadiness();
        let saved: TripState | null = null;
        try { saved = await readActiveTrip(uid); } catch { saved = null; }
        if (!saved) saved = await recoverServerTrip();
        if (saved && alive) {
          setTrip(saved);
          await refreshQueue();
          const notice = { title: t('trackingNotificationTitle'), body: t('trackingNotificationBody'), lowBatteryBody: t('lowBatteryWarning') };
          await saveTrackingNotice(uid, notice);
          if (!(await isTripLocationTaskStarted())) await startTripLocationTask(notice);
          void getDoc(doc(firestore, 'trips', saved.id)).then(snapshot => {
            if (snapshot.exists() && snapshot.get('status') === 'started') return;
            return stopTripLocationTask().then(() => clearActiveTrip(uid)).then(() => { if (alive) setTrip(null); });
          }).catch(() => undefined);
        } else if (!saved) await stopTripLocationTask();
        void flushPendingUploads(uid).then(refreshQueue);
      } catch { if (alive) setError('tripResumeFailed'); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [uid, refreshQueue, refreshReadiness, recoverServerTrip, t]);

  useEffect(() => {
    const timer = setInterval(() => setClockNow(eventTime()), 1_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const networkSubscription = addNetworkStateListener(state => {
      const online = state.isConnected === true && state.isInternetReachable === true;
      setConnected(online);
      if (online && uid) void flushPendingUploads(uid).then(refreshQueue);
    });
    const appSubscription = AppState.addEventListener('change', state => {
      if (state === 'active') { void refreshReadiness(); if (uid) void flushPendingUploads(uid).then(refreshQueue); }
    });
    return () => { networkSubscription.remove(); appSubscription.remove(); };
  }, [uid, refreshQueue, refreshReadiness]);

  useEffect(() => {
    if (!trip) return;
    const unsubscribe = onValue(ref(realtime, `live/${trip.vanId}`), snapshot => setLive(snapshot.val() as LiveState), () => setConnected(false));
    return unsubscribe;
  }, [trip]);

  useEffect(() => {
    let alive = true;
    if (!trip) return () => { alive = false; };
    const sampleBattery = async () => {
      try { const level = await Battery.getBatteryLevelAsync(); if (alive) setBattery(level >= 0 ? Math.round(level * 100) : null); }
      catch { if (alive) setBattery(null); }
    };
    void sampleBattery();
    const timer = setInterval(() => void sampleBattery(), 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, [trip]);

  const stopActions = useMemo(() => (stop: TripState['stops'][number]): StopStatus[] => {
    if (stop.status === 'pending') return ['arrived', 'skipped'];
    if (stop.status === 'arrived') return trip?.type === 'morning' ? ['picked_up', 'absent', 'skipped'] : ['dropped', 'skipped'];
    return [];
  }, [trip?.type]);

  const start = async (tripType: TripType) => {
    if (!vanId || !uid) { setError('vanAssignmentMissing'); return; }
    setBusy(true); setError(null);
    let serverTripId: string | null = null;
    try {
      await refreshReadiness();
      const foreground = await Location.getForegroundPermissionsAsync();
      const background = await Location.getBackgroundPermissionsAsync();
      const provider = await Location.getProviderStatusAsync();
      if (!foreground.granted || !background.granted || !LocationAccuracyIsPrecise(foreground) || !provider.locationServicesEnabled || provider.gpsAvailable === false) {
        setCriticalReady(false); setError('tripNeedsHealthCheck'); return;
      }
      const create = httpsCallable<{ vanId: string; type: TripType }, StartResponse>(functions, 'startTrip');
      const response = await create({ vanId, type: tripType });
      const started = response.data;
      serverTripId = started.tripId;
      const next = createTrip({ id: started.tripId, vanId: started.vanId, type: started.type, startedAt: started.startedAt, stops: started.stops, schoolLocation: started.schoolLocation, anotherTripActive: false });
      const notice = { title: t('trackingNotificationTitle'), body: t('trackingNotificationBody'), lowBatteryBody: t('lowBatteryWarning') };
      await saveTrackingNotice(uid, notice);
      await saveActiveTrip(uid, next);
      setTrip(next);
      await startTripLocationTask(notice);
      await refreshQueue();
    } catch {
      if (serverTripId && uid) {
        try {
          await stopTripLocationTask();
          const cancel = httpsCallable(functions, 'endTrip');
          await cancel({ tripId: serverTripId, endedAt: eventTime(), cancelled: true });
          await clearActiveTrip(uid);
          setTrip(null);
        } catch { /* The server active-trip pointer remains available for recovery and cleanup. */ }
      }
      setError('tripStartFailed');
    } finally { setBusy(false); }
  };

  const updateStop = async (childId: string, status: StopStatus) => {
    if (!trip || !uid) return;
    setBusy(true); setError(null);
    try {
      const next = transitionStop(trip, childId, status);
      const eventId = doc(collection(firestore, 'trips', trip.id, 'events')).id;
      const occurredAt = Math.max(trip.startedAt, eventTime());
      const item = { key: eventId, kind: 'stop_action' as const, createdAt: occurredAt, payload: { tripId: trip.id, childId, status, eventId, occurredAt } };
      await saveActiveTrip(uid, next);
      try { await enqueueUpload(uid, item); }
      catch (queueError) { await saveActiveTrip(uid, trip); throw queueError; }
      setTrip(next);
      void flushPendingUploads(uid).then(refreshQueue);
    } catch { setError('stopSaveFailed'); }
    finally { setBusy(false); }
  };

  const showEmergencyOptions = () => {
    if (!trip) return;
    Alert.alert(t('emergencyTitle'), t('emergencyConfirm'), [
      { text: t('cancelEdit'), style: 'cancel' },
      { text: t('sendEmergencyAlert'), style: 'destructive', onPress: () => {
        void (async () => {
          try {
            const eventId = doc(collection(firestore, 'trips', trip.id, 'events')).id;
            await httpsCallable(functions, 'sendEmergencyAlert')({ tripId: trip.id, eventId });
            setError(null);
          } catch { setError('emergencySendFailed'); }
        })();
      } },
      { text: t('callEmergencyNumber'), onPress: () => {
        void (async () => {
          const van = await getDoc(doc(firestore, 'vans', trip.vanId)).catch(() => null);
          const phone = van?.get('emergencyPhone');
          if (typeof phone === 'string' && /^\+[1-9]\d{7,14}$/.test(phone)) await Linking.openURL(`tel:${phone}`);
          else setError('emergencyNumberUnavailable');
        })();
      } }
    ]);
  };

  const end = async (cancelled: boolean) => {
    if (!trip || !uid) return;
    setBusy(true); setError(null);
    const ended = finishTrip(trip, Math.max(trip.startedAt, eventTime()), cancelled);
    try {
      await stopTripLocationTask();
      await enqueueUpload(uid, { key: `finish:${trip.id}`, kind: 'finish_trip', createdAt: ended.endedAt!, payload: { tripId: trip.id, endedAt: ended.endedAt, cancelled } });
      await clearActiveTrip(uid);
      setTrip(null);
      void flushPendingUploads(uid).then(refreshQueue);
    } catch { setError('tripEndFailed'); }
    finally { setBusy(false); }
  };

  if (loading) return <View style={styles.center}><ActivityIndicator color={colors.primary} /><Text style={styles.body}>{t('loading')}</Text></View>;
  if (!vanId) return <Card style={styles.card}><Text style={styles.title}>{t('vanAssignmentMissing')}</Text></Card>;

  const lastSent = live?.timestamp ? new Intl.DateTimeFormat(i18n.language === 'hi' ? 'hi-IN' : 'en-IN', { hour: '2-digit', minute: '2-digit' }).format(new Date(live.timestamp)) : null;
  const fixAge = live?.timestamp ? clockNow - live.timestamp : Number.POSITIVE_INFINITY;
  const gpsStatus = !live || !live.tripActive ? t('trackingWaiting') : fixAge > 60_000 ? t('trackingStale') : (live.accuracy ?? 51) <= 50 ? t('trackingGpsOk') : t('trackingGpsWeak');

  return <ScrollView contentContainerStyle={styles.content}>
    {!trip ? <>
      <Card style={styles.card}><Text style={styles.title}>{t('tripHomeTitle')}</Text><Text style={styles.body}>{t('tripHomeHelp')}</Text>
      {!criticalReady && <View style={styles.notice}><Text style={styles.body}>{t('tripNeedsHealthCheck')}</Text><Button label={t('openHealthCheck')} variant="secondary" onPress={onOpenHealth} /></View>}
        <Button label={busy ? t('tripStarting') : t('startMorningTrip')} onPress={() => void start('morning')} disabled={busy || !criticalReady} />
        <Button label={busy ? t('tripStarting') : t('startAfternoonTrip')} onPress={() => void start('afternoon')} variant="secondary" disabled={busy || !criticalReady} />
      </Card>
      <Card style={styles.card}><Text style={styles.body}>{t('offlineQueueSummary', { count: queued })}</Text></Card>
    </> : <>
      <Card style={styles.tripBanner}>
        <Text style={styles.eyebrow}>{t('activeTrip')}</Text><Text style={styles.title}>{t(trip.type === 'morning' ? 'startMorningTrip' : 'startAfternoonTrip')}</Text>
        <Text style={styles.body}>{t('trackingStatusLabel')}: {gpsStatus} · {connected ? t('internetConnected') : t('internetOffline')}</Text>
        {!notificationsAllowed && <Text style={styles.body}>{t('tripNotificationsOff')}</Text>}
        <Text style={styles.body}>{lastSent ? t('lastPositionAt', { time: lastSent }) : t('trackingNoPosition')}</Text>
        {battery !== null && battery < 20 && <Text style={styles.lowBattery}>{t('lowBatteryWarning')}</Text>}
        {queued > 0 && <Text style={styles.body}>{t('offlineQueueSummary', { count: queued })}</Text>}
      </Card>
      <Button label={t('emergencyButton')} variant="secondary" onPress={showEmergencyOptions} disabled={busy} />
      {trip.stops.map(stop => <Card key={stop.childId} style={styles.stopCard}>
        <View style={styles.stopHeader}><View style={styles.stopCopy}><Text style={styles.stopName}>{stop.name}</Text><Text style={styles.stopStatus}>{t(`stopStatus_${stop.status}`)}</Text></View><Text style={styles.stopCount}>{trip.stops.findIndex(item => item.childId === stop.childId) + 1}/{trip.stops.length}</Text></View>
        <View style={styles.actions}>{stopActions(stop).map(action => <Button key={action} label={t(`stopAction_${action}`)} variant={action === 'arrived' || action === 'picked_up' || action === 'dropped' ? 'primary' : 'secondary'} onPress={() => void updateStop(stop.childId, action)} style={styles.actionButton} disabled={busy} />)}</View>
      </Card>)}
      <Card style={styles.card}><Button label={busy ? t('saving') : t('endTrip')} onPress={() => void end(false)} disabled={busy} /><Button label={t('cancelTrip')} variant="secondary" onPress={() => void end(true)} disabled={busy} /></Card>
    </>}
    {error && <Text accessibilityRole="alert" style={styles.error}>{t(error)}</Text>}
  </ScrollView>;
}

function LocationAccuracyIsPrecise(permission: Location.LocationPermissionResponse): boolean {
  return Platform.OS === 'android' ? permission.android?.accuracy === 'fine' : permission.ios?.accuracy === 'full';
}

const styles = StyleSheet.create({ content: { gap: spacing.md, paddingBottom: spacing.xl }, card: { gap: spacing.sm }, tripBanner: { gap: spacing.xs, backgroundColor: colors.tile, borderColor: colors.tile, padding: spacing.lg }, title: { color: colors.ink, fontSize: type.tagline.size, fontWeight: '600', lineHeight: type.tagline.lineHeight }, eyebrow: { color: colors.primaryOnDark, fontSize: type.caption.size, fontWeight: '600' }, body: { color: colors.mutedInk, fontSize: type.body.size, lineHeight: type.body.lineHeight }, stopCard: { gap: spacing.sm, padding: spacing.md }, stopHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm }, stopCopy: { flex: 1 }, stopName: { color: colors.ink, fontSize: type.bodyStrong.size, fontWeight: '600' }, stopStatus: { color: colors.mutedInk, fontSize: type.caption.size }, stopCount: { color: colors.mutedInk, fontSize: type.caption.size }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }, actionButton: { flexGrow: 1, minWidth: '46%', paddingHorizontal: spacing.sm }, notice: { gap: spacing.sm, padding: spacing.md, backgroundColor: colors.parchment, borderRadius: 12 }, lowBattery: { color: colors.warning, fontSize: type.bodyStrong.size, fontWeight: '700' }, center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: spacing.sm }, error: { color: colors.danger, fontSize: type.body.size } });
