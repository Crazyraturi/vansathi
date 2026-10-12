import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, SafeAreaView, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Camera, Map as MapView, Marker } from '@maplibre/maplibre-react-native';
import { collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, query, setDoc, updateDoc, where, Timestamp } from '@react-native-firebase/firestore';
import { onValue, ref } from '@react-native-firebase/database';
import { httpsCallable } from '@react-native-firebase/functions';
import { getMessaging, onMessage } from '@react-native-firebase/messaging';
import * as Notifications from 'expo-notifications';
import { Button } from '../shared/ui/Button';
import { Card } from '../shared/ui/Card';
import { EmptyState } from '../shared/ui/EmptyState';
import { StatusPill } from '../shared/ui/StatusPill';
import { distanceKm, estimateEtaMinutes, locationFreshness } from './parentLogic';
import { registerPushNotifications } from '../shared/notifications/push';
import { auth, firestore, functions, realtime } from '../shared/firebase/client';
import { colors, spacing, type } from '../shared/theme/tokens';

type Child = { id: string; vanId: string; name: string; class?: string; homeLocation: { lat: number; lng: number } };
type Van = { id: string; name: string; number: string; school?: { name?: string; lat?: number; lng?: number } };
type Trip = { id: string; vanId: string; type: 'morning' | 'afternoon'; status: string; startedAt?: Timestamp | number; endedAt?: Timestamp | number; stops?: { childId: string; name: string; status: string }[] };
type Live = { lat: number; lng: number; speed: number; timestamp: number; tripId: string; tripActive: boolean };
type Event = { id: string; childId?: string; type?: string; status?: string; createdAt?: Timestamp | number; timestamp?: Timestamp | number };
type Contact = { name: string; phone: string };
type NotificationPreferences = { tripUpdates: boolean; locationWarnings: boolean; emergencyAlerts: boolean };
type Tab = 'home' | 'history' | 'settings';

const styleURL = process.env.EXPO_PUBLIC_MAP_STYLE_URL?.startsWith('https://') ? process.env.EXPO_PUBLIC_MAP_STYLE_URL : undefined;
const privacyPolicyURL = process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL;
const millis = (value: unknown): number => value instanceof Timestamp ? value.toMillis() : typeof value === 'number' ? value : 0;
const dateKey = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: 'year' | 'month' | 'day') => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const activeTrip = (trips: Trip[], vanId: string) => trips.find(trip => trip.vanId === vanId && trip.status === 'started');

export function ParentHome({ onSignOut, onDeleteAccount }: { onSignOut: () => void; onDeleteAccount: () => void }) {
  const { t, i18n } = useTranslation();
  const uid = auth.currentUser?.uid;
  const [tab, setTab] = useState<Tab>('home');
  const [children, setChildren] = useState<Child[]>([]);
  const [vans, setVans] = useState<Record<string, Van>>({});
  const [trips, setTrips] = useState<Trip[]>([]);
  const [live, setLive] = useState<Record<string, Live | null>>({});
  const [events, setEvents] = useState<Record<string, Event[]>>({});
  const [absences, setAbsences] = useState<Record<string, boolean>>({});
  const [contacts, setContacts] = useState<Record<string, Contact>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [clock, setClock] = useState(0);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences>({ tripUpdates: true, locationWarnings: true, emergencyAlerts: true });

  const openPrivacyPolicy = () => {
    if (!privacyPolicyURL?.startsWith('https://')) { Alert.alert(t('privacyTitle'), t('privacyPolicyLocation')); return; }
    void Linking.openURL(privacyPolicyURL).catch(() => Alert.alert(t('privacyTitle'), t('privacyPolicyLocation')));
  };

  const load = useCallback(async () => {
    if (!uid) { setLoading(false); return; }
    setLoading(true); setError(false);
    try {
      const childSnap = await getDocs(query(collection(firestore, 'children'), where('parentUid', '==', uid)));
      const profile = await getDoc(doc(firestore, 'users', uid));
      const storedPreferences = profile.data()?.notificationPreferences as Partial<NotificationPreferences> | undefined;
      if (storedPreferences) setNotificationPreferences({ tripUpdates: storedPreferences.tripUpdates !== false, locationWarnings: storedPreferences.locationWarnings !== false, emergencyAlerts: storedPreferences.emergencyAlerts !== false });
      setProfileLoaded(true);
      const linked = childSnap.docs.map(item => ({ id: item.id, ...item.data() } as Child));
      setChildren(linked);
      const vanIds = [...new Set(linked.map(child => child.vanId))];
      const vanPairs = await Promise.all(vanIds.map(async id => {
        const snapshot = await getDoc(doc(firestore, 'vans', id));
        return snapshot.exists() ? [id, { id, ...snapshot.data() } as Van] as const : null;
      }));
      setVans(Object.fromEntries(vanPairs.filter((item): item is NonNullable<typeof item> => item !== null)));
      if (!vanIds.length) { setTrips([]); setLoading(false); return; }
      const cutoff = Timestamp.fromMillis(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const vanGroups = Array.from({ length: Math.ceil(vanIds.length / 10) }, (_, index) => vanIds.slice(index * 10, index * 10 + 10));
      const [activeGroups, recentGroups] = await Promise.all([
        Promise.all(vanGroups.map(group => getDocs(query(collection(firestore, 'trips'), where('vanId', 'in', group), where('status', '==', 'started'))))),
        Promise.all(vanGroups.map(group => getDocs(query(collection(firestore, 'trips'), where('vanId', 'in', group), where('endedAt', '>=', cutoff)))))
      ]);
      const tripRows = [...new Map([...activeGroups.flatMap(snapshot => snapshot.docs), ...recentGroups.flatMap(snapshot => snapshot.docs)].map(item => [item.id, { id: item.id, ...item.data() } as Trip])).values()];
      setTrips(tripRows);
      const absenceSnap = await getDocs(query(collection(firestore, 'absences'), where('parentUid', '==', uid), where('date', '==', dateKey())));
      setAbsences(Object.fromEntries(absenceSnap.docs.filter(item => item.get('cancelled') !== true).map(item => [item.get('childId') + ':' + item.get('tripType'), true])));
      const eventRows = await Promise.all(tripRows.map(async trip => {
        const snap = await getDocs(collection(firestore, 'trips', trip.id, 'events'));
        return [trip.id, snap.docs.map(item => ({ id: item.id, ...item.data() } as Event))] as const;
      }));
      setEvents(Object.fromEntries(eventRows));
      try {
        const call = httpsCallable<void, Record<string, Contact>>(functions, 'getParentVanContacts');
        const result = await call();
        setContacts(result.data);
      } catch { setContacts({}); }
    } catch { setError(true); }
    finally { setLoading(false); }
  }, [uid]);

  useEffect(() => {
    const handle = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(handle);
  }, [load]);
  useEffect(() => {
    if (!uid) return;
    const unsub = onSnapshot(query(collection(firestore, 'children'), where('parentUid', '==', uid)), snapshot => {
      const next = snapshot.docs.map(item => ({ id: item.id, ...item.data() } as Child));
      setChildren(next);
    }, () => setError(true));
    return unsub;
  }, [uid]);
  useEffect(() => {
    const vanIds = [...new Set(children.map(child => child.vanId))];
    const recentCutoff = Timestamp.fromMillis(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const unsubscribers = vanIds.flatMap(vanId => [
      onSnapshot(query(collection(firestore, 'trips'), where('vanId', '==', vanId), where('status', '==', 'started')), snapshot => {
        setTrips(current => [...current.filter(trip => !(trip.vanId === vanId && trip.status === 'started')), ...snapshot.docs.map(item => ({ id: item.id, ...item.data() } as Trip))]);
      }, () => setError(true)),
      onSnapshot(query(collection(firestore, 'trips'), where('vanId', '==', vanId), where('endedAt', '>=', recentCutoff)), snapshot => {
        setTrips(current => [...current.filter(trip => !(trip.vanId === vanId && trip.status !== 'started')), ...snapshot.docs.map(item => ({ id: item.id, ...item.data() } as Trip))]);
      }, () => setError(true))
    ]);
    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
  }, [children]);
  useEffect(() => {
    const ids = [...new Set(children.filter(child => activeTrip(trips, child.vanId)).map(child => child.vanId))];
    const cleanups = ids.map(vanId => onValue(ref(realtime, `live/${vanId}`), snapshot => {
      setLive(current => ({ ...current, [vanId]: snapshot.val() as Live | null }));
    }, () => setLive(current => ({ ...current, [vanId]: null }))));
    return () => cleanups.forEach(unsubscribe => unsubscribe());
  }, [children, trips]);
  useEffect(() => {
    if (!uid || !profileLoaded || !Object.values(notificationPreferences).some(Boolean)) return;
    void registerPushNotifications(uid, { generalChannel: t('tripNotificationChannel'), emergencyChannel: t('emergencyChannel') }).catch(() => undefined);
  }, [uid, profileLoaded, notificationPreferences, t]);
  useEffect(() => onMessage(getMessaging(), message => {
    if (!message.notification?.title || !message.notification.body) return;
    void Notifications.scheduleNotificationAsync({ content: { title: message.notification.title, body: message.notification.body, data: message.data }, trigger: null });
  }), []);
  useEffect(() => {
    const firstTick = setTimeout(() => setClock(Date.now()), 0);
    const timer = setInterval(() => setClock(Date.now()), 10_000);
    return () => { clearTimeout(firstTick); clearInterval(timer); };
  }, []);
  useEffect(() => {
    const active = trips.filter(trip => trip.status === 'started');
    const cleanups = active.map(trip => onSnapshot(collection(firestore, 'trips', trip.id, 'events'), snapshot => {
      setEvents(current => ({ ...current, [trip.id]: snapshot.docs.map(item => ({ id: item.id, ...item.data() } as Event)) }));
    }, () => undefined));
    return () => cleanups.forEach(unsubscribe => unsubscribe());
  }, [trips]);

  const placeAbsence = async (child: Child, tripType: 'morning' | 'afternoon') => {
    const key = `${child.id}:${tripType}`;
    const id = `${dateKey()}_${tripType}_${child.id}`;
    if (!uid) return;
    setBusy(true);
    try {
      const reference = doc(firestore, 'absences', id);
      if (absences[key]) await deleteDoc(reference);
      else await setDoc(reference, { parentUid: uid, childId: child.id, tripType, date: dateKey() });
      setAbsences(current => ({ ...current, [key]: !current[key] }));
    } catch { setError(true); }
    finally { setBusy(false); }
  };

  const formatTime = (value: unknown) => value ? new Intl.DateTimeFormat(i18n.language === 'hi' ? 'hi-IN' : 'en-IN', { hour: 'numeric', minute: '2-digit' }).format(new Date(millis(value))) : '';
  const callDriver = (vanId: string) => { const phone = contacts[vanId]?.phone; if (phone) void Linking.openURL(`tel:${phone}`); };
  const updatePreference = async (key: keyof NotificationPreferences, value: boolean) => {
    if (!uid) return;
    const next = { ...notificationPreferences, [key]: value };
    setNotificationPreferences(next);
    try { await updateDoc(doc(firestore, 'users', uid), { notificationPreferences: next }); }
    catch { setNotificationPreferences(notificationPreferences); setError(true); }
  };
  const changeLanguage = async (language: 'en' | 'hi') => {
    if (!uid) return;
    try {
      await updateDoc(doc(firestore, 'users', uid), { language });
      await i18n.changeLanguage(language);
    } catch { setError(true); }
  };
  const selectedTrip = useMemo(() => Object.fromEntries(children.map(child => [child.id, activeTrip(trips, child.vanId)])), [children, trips]);

  if (loading) return <SafeAreaView style={styles.center}><ActivityIndicator color={colors.primary} /><Text style={styles.body}>{t('loading')}</Text></SafeAreaView>;
  if (error && !children.length) return <SafeAreaView style={styles.page}><EmptyState title={t('errorTitle')} body={t('parentLoadError')} actionLabel={t('retry')} onAction={() => void load()} /></SafeAreaView>;
  if (!children.length) return <SafeAreaView style={styles.page}><View style={styles.top}><Text style={styles.brand}>{t('brand')}</Text><Button label={t('signOut')} variant="secondary" onPress={onSignOut} /></View><EmptyState title={t('emptyTitle')} body={t('emptyBody')} /></SafeAreaView>;

  return <SafeAreaView style={styles.safe}>
    <View style={styles.top}><View><Text style={styles.brand}>{t('parentHomeTitle')}</Text><Text style={styles.caption}>{t('parentHomeSubtitle')}</Text></View><Button label={t('signOut')} variant="secondary" onPress={onSignOut} style={styles.signout} /></View>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{t('parentLoadError')} <Text onPress={() => void load()} style={styles.callText}>{t('retry')}</Text></Text> : null}
    <View style={styles.tabs}>{(['home', 'history', 'settings'] as Tab[]).map(item => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: tab === item }} onPress={() => setTab(item)} style={[styles.tab, tab === item && styles.tabOn]}><Text style={[styles.tabLabel, tab === item && styles.tabLabelOn]}>{t(`parentTab_${item}`)}</Text></Pressable>)}</View>
    {tab === 'home' && <ScrollView contentContainerStyle={styles.content}>
      {children.map(child => {
        const trip = selectedTrip[child.id];
        const point = live[child.vanId];
        const current = point?.tripActive && trip?.id === point.tripId ? point : null;
        const ageSeconds = current ? Math.max(0, Math.floor((clock - current.timestamp) / 1000)) : Infinity;
        const freshness = current ? locationFreshness(ageSeconds) : 'lost';
        const liveState = freshness === 'live' ? 'good' : freshness === 'delayed' ? 'warning' : 'danger';
        const van = vans[child.vanId];
        const childEvents = trip ? events[trip.id] ?? [] : [];
        const childStatus = trip ? childEvents.filter(event => event.childId === child.id).sort((a, b) => millis(b.createdAt ?? b.timestamp) - millis(a.createdAt ?? a.timestamp))[0] : undefined;
        const statusLabel = childStatus?.status ? t(`stop_${childStatus.status}`, { defaultValue: t('parentOnTheWay') }) : trip ? t('parentOnTheWay') : t('noTrip');
        return <Card key={child.id} style={styles.childCard}>
          <View style={styles.cardHead}><View style={styles.nameBlock}><Text style={styles.childName}>{child.name}</Text><Text style={styles.caption}>{van?.name ?? van?.number ?? t('vanDetailsUnavailable')}</Text></View><StatusPill label={statusLabel} tone={childStatus ? 'good' : 'neutral'} /></View>
          <View style={styles.driverRow}><Text style={styles.body}>{t('parentDriver', { name: contacts[child.vanId]?.name ?? van?.name ?? t('driver') })}</Text>{contacts[child.vanId]?.phone ? <Pressable accessibilityRole="button" accessibilityLabel={t('callDriver')} onPress={() => callDriver(child.vanId)} style={styles.call}><Text style={styles.callText}>{t('callDriver')}</Text></Pressable> : null}</View>
          {trip ? <>
            <StatusPill label={liveState === 'good' ? t('locationLive') : liveState === 'warning' ? t('locationDelayed') : t('locationLost')} tone={liveState} />
            {freshness !== 'live' ? <Text accessibilityRole="alert" style={styles.warning}>{t('locationNotUpdating')}</Text> : null}
            {current ? <Text style={styles.caption}>{t('lastUpdated', { seconds: ageSeconds })}</Text> : null}
            {styleURL && current ? <View style={styles.map}><MapView style={styles.mapInner} mapStyle={styleURL} logo={false} attribution={false}><Camera center={[current.lng, current.lat]} zoom={14} duration={500} easing="fly" /><Marker id={`van-${child.id}`} lngLat={[current.lng, current.lat]}><View style={styles.vanMarker}><Text style={styles.markerLabel}>{t('vanMarker')}</Text></View></Marker><Marker id={`home-${child.id}`} lngLat={[child.homeLocation.lng, child.homeLocation.lat]}><View style={styles.homeMarker} /></Marker></MapView></View> : styleURL ? <View style={[styles.map, styles.mapEmpty]}><Text style={styles.caption}>{t('waitingForVanLocation')}</Text></View> : <Text style={styles.caption}>{t('mapProviderMissing')}</Text>}
            {current ? <Text style={styles.caption}>{t('distanceEta', { distance: distanceKm(current.lat, current.lng, child.homeLocation.lat, child.homeLocation.lng).toFixed(1), eta: estimateEtaMinutes(distanceKm(current.lat, current.lng, child.homeLocation.lat, child.homeLocation.lng), current.speed) })}</Text> : null}
          </> : <Text style={styles.body}>{t('noTrip')}</Text>}
          <View style={styles.absence}><Text style={styles.label}>{t('absenceTitle')}</Text><View style={styles.absenceChoices}>{(['morning', 'afternoon'] as const).map(kind => <Pressable key={kind} onPress={() => void placeAbsence(child, kind)} disabled={busy} accessibilityRole="button" accessibilityState={{ selected: !!absences[`${child.id}:${kind}`] }} style={[styles.absenceChoice, absences[`${child.id}:${kind}`] && styles.absenceOn]}><Text style={[styles.absenceLabel, absences[`${child.id}:${kind}`] && styles.absenceLabelOn]}>{t(`tripType_${kind}`)} · {absences[`${child.id}:${kind}`] ? t('absenceReported') : t('absenceReport')}</Text></Pressable>)}</View></View>
          {childStatus ? <Text style={styles.caption}>{t('lastChildUpdate', { time: formatTime(childStatus.createdAt ?? childStatus.timestamp) })}</Text> : null}
        </Card>;
      })}
    </ScrollView>}
    {tab === 'history' && <ScrollView contentContainerStyle={styles.content}>{children.map(child => {
      const vanTrips = trips.filter(trip => trip.vanId === child.vanId && trip.status !== 'started').sort((a, b) => millis(b.endedAt) - millis(a.endedAt));
      return <Card key={child.id} style={styles.childCard}><Text style={styles.childName}>{child.name}</Text>{vanTrips.length ? vanTrips.map(trip => {
        const related = (events[trip.id] ?? []).filter(event => event.childId === child.id);
        return <View key={trip.id} style={styles.historyRow}><Text style={styles.body}>{t(`tripType_${trip.type}`)} · {formatTime(trip.startedAt)}</Text><Text style={styles.caption}>{related.map(event => t(`stop_${event.status ?? event.type}`, { defaultValue: t('tripUpdated') })).join(' · ') || t('tripUpdated')}</Text></View>;
      }) : <Text style={styles.body}>{t('historyEmpty')}</Text>}</Card>;
    })}</ScrollView>}
    {tab === 'settings' && <ScrollView contentContainerStyle={styles.content}><Card style={styles.childCard}><Text style={styles.childName}>{t('settingsTitle')}</Text><Text style={styles.label}>{t('language')}</Text><View style={styles.languageRow}><Button label={t('english')} variant={i18n.language === 'en' ? 'primary' : 'secondary'} onPress={() => void changeLanguage('en')} style={styles.languageButton} /><Button label={t('hindi')} variant={i18n.language === 'hi' ? 'primary' : 'secondary'} onPress={() => void changeLanguage('hi')} style={styles.languageButton} /></View><Text style={styles.label}>{t('notificationPreferences')}</Text>{(['tripUpdates', 'locationWarnings', 'emergencyAlerts'] as const).map(key => <View key={key} style={styles.preferenceRow}><Text style={styles.body}>{t(`notification_${key}`)}</Text><Switch value={notificationPreferences[key]} onValueChange={value => void updatePreference(key, value)} accessibilityLabel={t(`notification_${key}`)} trackColor={{ false: colors.hairline, true: colors.primary }} /></View>)}<Text style={styles.label}>{t('privacyTitle')}</Text><Text style={styles.body}>{t('privacyBody')}</Text><Text style={styles.body}>{t('privacyLocation')}</Text><Text style={styles.body}>{t('privacyRetention')}</Text><Text style={styles.body}>{t('privacyMapProvider')}</Text><Text style={styles.body}>{t('privacyChoice')}</Text><Text style={styles.caption}>{t('privacyPolicyLocation')}</Text><Button label={t('privacyPolicyOpen')} variant="secondary" onPress={openPrivacyPolicy} /><Button label={t('deleteAccount')} variant="secondary" onPress={onDeleteAccount} /><Button label={t('signOut')} variant="secondary" onPress={onSignOut} /></Card></ScrollView>}
  </SafeAreaView>;
}

const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: colors.parchment }, page: { flex: 1, backgroundColor: colors.parchment, padding: spacing.lg, gap: spacing.lg }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: colors.parchment }, top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md }, brand: { color: colors.ink, fontSize: type.title.size, lineHeight: type.title.lineHeight, fontWeight: '700' }, caption: { color: colors.mutedInk, fontSize: type.caption.size, lineHeight: type.caption.lineHeight }, tabs: { flexDirection: 'row', borderBottomWidth: 1, borderColor: colors.hairline, paddingHorizontal: spacing.md }, tab: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' }, tabOn: { borderBottomColor: colors.primary }, tabLabel: { color: colors.mutedInk, fontSize: type.caption.size, fontWeight: '600' }, tabLabelOn: { color: colors.primary }, content: { gap: spacing.md, padding: spacing.lg, paddingBottom: spacing.xl }, childCard: { gap: spacing.md }, cardHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.sm }, nameBlock: { flex: 1, gap: 2 }, childName: { color: colors.ink, fontSize: type.tagline.size, lineHeight: type.tagline.lineHeight, fontWeight: '700' }, body: { color: colors.mutedInk, fontSize: type.body.size, lineHeight: type.body.lineHeight }, driverRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm }, call: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md }, callText: { color: colors.primary, fontSize: type.bodyStrong.size, fontWeight: '700' }, warning: { color: colors.danger, fontSize: type.bodyStrong.size, fontWeight: '600' }, error: { color: colors.danger, fontSize: type.body.size, paddingHorizontal: spacing.lg }, map: { height: 230, borderRadius: 14, overflow: 'hidden', backgroundColor: colors.parchment }, mapInner: { flex: 1 }, mapEmpty: { alignItems: 'center', justifyContent: 'center' }, vanMarker: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20, backgroundColor: colors.primary }, markerLabel: { color: colors.bodyOnDark, fontSize: 12, fontWeight: '700' }, homeMarker: { width: 18, height: 18, borderRadius: 9, borderWidth: 4, borderColor: colors.primary, backgroundColor: colors.canvas }, absence: { gap: spacing.xs }, label: { color: colors.ink, fontSize: type.caption.size, fontWeight: '700' }, absenceChoices: { flexDirection: 'row', gap: spacing.sm }, absenceChoice: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.hairline, paddingHorizontal: spacing.xs }, absenceOn: { backgroundColor: colors.primary, borderColor: colors.primary }, absenceLabel: { color: colors.ink, textAlign: 'center', fontSize: type.caption.size, fontWeight: '600' }, absenceLabelOn: { color: colors.bodyOnDark }, historyRow: { gap: 4, borderBottomWidth: 1, borderColor: colors.hairline, paddingVertical: spacing.sm }, languageRow: { flexDirection: 'row', gap: spacing.sm }, preferenceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, minHeight: 50 }, languageButton: { flex: 1 }, signout: { minHeight: 44 } });
