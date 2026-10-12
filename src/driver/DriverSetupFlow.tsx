import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, updateDoc, where, writeBatch } from '@react-native-firebase/firestore';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as Network from 'expo-network';
import * as IntentLauncher from 'expo-intent-launcher';
import { Camera, Map, Marker } from '@maplibre/maplibre-react-native';
import DraggableFlatList, { type RenderItemParams } from 'react-native-draggable-flatlist';
import { firestore } from '../shared/firebase/client';
import { Button } from '../shared/ui/Button';
import { Card } from '../shared/ui/Card';
import { colors, spacing, type } from '../shared/theme/tokens';
import { DriverTripFlow } from './DriverTripFlow';

type Pin = { lat: number; lng: number };
type School = { name: string; lat: number; lng: number };
type Van = { number?: string; name?: string; seats?: number; school?: School; emergencyPhone?: string };
type Child = { id: string; vanId: string; name: string; class: string; parentPhone: string; parentUid: string | null; homeLocation: Pin; morningOrder: number; afternoonOrder: number };
type Section = 'van' | 'children' | 'health' | 'trip';
type Check = 'ok' | 'needs' | 'warning';
const privacyPolicyURL = process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL;

function Field({ label, value, onChangeText, keyboardType, placeholder }: { label: string; value: string; onChangeText: (value: string) => void; keyboardType?: 'default' | 'phone-pad' | 'number-pad'; placeholder?: string }) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} keyboardType={keyboardType} placeholder={placeholder} style={styles.input} /></View>;
}

function PinPicker({ title, pin, onChange }: { title: string; pin: Pin | null; onChange: (pin: Pin) => void }) {
  const { t } = useTranslation();
  const [showRationale, setShowRationale] = useState(false);
  const [locationUnavailable, setLocationUnavailable] = useState(false);
  const styleURL = process.env.EXPO_PUBLIC_MAP_STYLE_URL?.startsWith('https://') ? process.env.EXPO_PUBLIC_MAP_STYLE_URL : undefined;
  const camera = useRef<React.ElementRef<typeof Camera>>(null);
  const initial = useMemo(() => pin ? [pin.lng, pin.lat] as [number, number] : undefined, [pin]);
  useEffect(() => { if (initial) camera.current?.easeTo({ center: initial, zoom: 13, duration: 250 }); }, [initial]);
  return <View style={styles.pinBox}>
    <View style={styles.rowBetween}><Text style={styles.label}>{title}</Text><Button label={t('useCurrentLocation')} variant="secondary" onPress={() => setShowRationale(true)} style={styles.smallButton} /></View>
    {locationUnavailable && <Text style={styles.error}>{t('locationUnavailable')}</Text>}
    {showRationale && <View style={styles.rationale}><Text style={styles.body}>{t('foregroundRationaleBody')}</Text><Button label={t('continue')} onPress={() => void (async () => {
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (permission.granted) { const result = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }); onChange({ lat: result.coords.latitude, lng: result.coords.longitude }); }
        else await Linking.openSettings();
      } catch { setLocationUnavailable(true); }
      setShowRationale(false);
    })()} /></View>}
    {styleURL ? <Map style={styles.map} mapStyle={styleURL} onPress={event => { const [lng, lat] = event.nativeEvent.lngLat; onChange({ lat, lng }); }}>
      <Camera ref={camera} initialViewState={initial ? { center: initial, zoom: 13 } : undefined} />
      {pin && <Marker id="selected-pin" lngLat={[pin.lng, pin.lat]}><View style={styles.pinDot} /></Marker>}
    </Map> : <View style={[styles.map, styles.mapMissing]}><Text style={styles.body}>{t('mapProviderMissing')}</Text></View>}
    {pin && <Text style={styles.caption}>{t('pinSelected', { lat: pin.lat.toFixed(5), lng: pin.lng.toFixed(5) })}</Text>}
  </View>;
}

export function DriverSetupFlow({ vanId, onSignOut, onDeleteAccount }: { vanId: string | null; onSignOut: () => void; onDeleteAccount: () => void }) {
  const { t } = useTranslation();
  const openPrivacyPolicy = () => {
    if (!privacyPolicyURL?.startsWith('https://')) { Alert.alert(t('privacyTitle'), t('privacyPolicyLocation')); return; }
    void Linking.openURL(privacyPolicyURL).catch(() => Alert.alert(t('privacyTitle'), t('privacyPolicyLocation')));
  };
  const [section, setSection] = useState<Section>('van');
  const [van, setVan] = useState<Van>({});
  const [schoolName, setSchoolName] = useState('');
  const [schoolPin, setSchoolPin] = useState<Pin | null>(null);
  const [children, setChildren] = useState<Child[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [childName, setChildName] = useState('');
  const [childClass, setChildClass] = useState('');
  const [parentPhone, setParentPhone] = useState('');
  const [homePin, setHomePin] = useState<Pin | null>(null);
  const [stopType, setStopType] = useState<'morningOrder' | 'afternoonOrder'>('morningOrder');
  const [checks, setChecks] = useState({ always: 'needs' as Check, precise: 'needs' as Check, gps: 'needs' as Check, notifications: 'needs' as Check, internet: 'needs' as Check, battery: Platform.OS === 'android' ? 'needs' as Check : 'ok' as Check });
  const [batteryConfirmed, setBatteryConfirmed] = useState(false);
  const [deviceHelp, setDeviceHelp] = useState<'xiaomi' | 'vivo' | 'samsung' | null>(null);
  const [permissionStep, setPermissionStep] = useState<'none' | 'foregroundRationale' | 'backgroundRationale'>('none');

  const refreshChildren = useCallback(async () => {
    if (!vanId) return;
    const result = await getDocs(query(collection(firestore, 'children'), where('vanId', '==', vanId)));
    setChildren(result.docs.map(item => ({ id: item.id, ...item.data() } as Child)));
  }, [vanId]);

  const refreshHealth = useCallback(async () => {
    try {
      const foreground = await Location.getForegroundPermissionsAsync();
      const background = await Location.getBackgroundPermissionsAsync();
      const providers = await Location.getProviderStatusAsync();
      const notification = await Notifications.getPermissionsAsync();
      const network = await Network.getNetworkStateAsync();
      const backgroundGranted = background.granted;
      const precise = Platform.OS === 'android' ? foreground.android?.accuracy === 'fine' : foreground.ios?.accuracy === 'full';
      setChecks(previous => ({ ...previous, always: foreground.granted && backgroundGranted ? 'ok' : 'needs', precise: foreground.granted && precise ? 'ok' : 'needs', gps: providers.locationServicesEnabled && (Platform.OS !== 'android' || providers.gpsAvailable !== false) ? 'ok' : 'needs', notifications: notification.granted ? 'ok' : 'needs', internet: network.isConnected && network.isInternetReachable === true ? 'ok' : 'needs' }));
    } catch { setErrorKey('healthCheckFailed'); }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!vanId) { setLoading(false); setErrorKey('vanAssignmentMissing'); return; }
      try {
        const snapshot = await getDoc(doc(firestore, 'vans', vanId));
        const data = snapshot.data() as Van | undefined;
        if (data && alive) {
          setVan(data); setSchoolName(data.school?.name ?? ''); setSchoolPin(data.school ? { lat: data.school.lat, lng: data.school.lng } : null);
          if (data.number && data.name && data.seats && data.school?.name && typeof data.school.lat === 'number' && typeof data.school.lng === 'number') setSection('trip');
        }
        await refreshChildren();
        await refreshHealth();
      } catch { if (alive) setErrorKey('setupFailed'); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [vanId, refreshChildren, refreshHealth]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void refreshHealth(); });
    return () => subscription.remove();
  }, [refreshHealth]);

  const ordered = useMemo(() => [...children].sort((a, b) => a[stopType] - b[stopType]), [children, stopType]);
  const saveVan = async () => {
    if (!vanId || !van.number?.trim() || !van.name?.trim() || !van.seats || !schoolName.trim() || !schoolPin) { setErrorKey('vanFieldsRequired'); return; }
    setSaving(true); setErrorKey(null);
    try {
      await updateDoc(doc(firestore, 'vans', vanId), { number: van.number.trim(), name: van.name.trim(), seats: Number(van.seats), school: { name: schoolName.trim(), ...schoolPin }, emergencyPhone: van.emergencyPhone?.trim() ?? '' });
      setSection('children');
    } catch { setErrorKey('setupFailed'); }
    finally { setSaving(false); }
  };

  const clearChildDraft = () => { setEditingId(null); setChildName(''); setChildClass(''); setParentPhone(''); setHomePin(null); };
  const editChild = (child: Child) => { setEditingId(child.id); setChildName(child.name); setChildClass(child.class); setParentPhone(child.parentPhone); setHomePin(child.homeLocation); };
  const saveChild = async () => {
    if (!vanId || !childName.trim() || (!parentPhone.trim() && !editingId) || (parentPhone.trim() !== '' && !/^\+[1-9]\d{7,14}$/.test(parentPhone.trim())) || !homePin) { setErrorKey('childFieldsRequired'); return; }
    setSaving(true); setErrorKey(null);
    try {
      if (editingId) await updateDoc(doc(firestore, 'children', editingId), { name: childName.trim(), class: childClass.trim(), parentPhone: parentPhone.trim(), homeLocation: homePin });
      else await addDoc(collection(firestore, 'children'), { vanId, name: childName.trim(), class: childClass.trim(), parentPhone: parentPhone.trim(), parentUid: null, homeLocation: homePin, morningOrder: children.length, afternoonOrder: children.length });
      clearChildDraft(); await refreshChildren();
    } catch { setErrorKey('setupFailed'); }
    finally { setSaving(false); }
  };
  const removeChild = async (id: string) => { try { await deleteDoc(doc(firestore, 'children', id)); await refreshChildren(); if (editingId === id) clearChildDraft(); } catch { setErrorKey('setupFailed'); } };
  const reorderStops = async ({ data }: { data: Child[] }) => {
    if (!vanId) return;
    setChildren(current => current.map(child => ({ ...child, [stopType]: data.findIndex(item => item.id === child.id) })));
    const batch = writeBatch(firestore);
    data.forEach((child, index) => batch.update(doc(firestore, 'children', child.id), { [stopType]: index }));
    try { await batch.commit(); } catch { setErrorKey('setupFailed'); await refreshChildren(); }
  };

  const openBatterySettings = async () => {
    if (Platform.OS !== 'android') { setBatteryConfirmed(true); return; }
    try { await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS); }
    catch { await Linking.openSettings(); }
  };
  const beginLocationFlow = async () => { setPermissionStep('foregroundRationale'); };
  const continueLocationFlow = async () => {
    if (permissionStep === 'foregroundRationale') {
      const result = await Location.requestForegroundPermissionsAsync();
      if (result.granted) setPermissionStep('backgroundRationale'); else { setPermissionStep('none'); await Linking.openSettings(); }
    } else if (permissionStep === 'backgroundRationale') {
      Alert.alert(t('backgroundRationaleTitle'), t('backgroundRationaleBody'), [
        { text: t('cancel'), style: 'cancel', onPress: () => setPermissionStep('none') },
        { text: t('continue'), onPress: () => void (async () => {
          setPermissionStep('none');
          const result = await Location.requestBackgroundPermissionsAsync();
          if (!result.granted) await Linking.openSettings();
          await refreshHealth();
        })() }
      ], { cancelable: false });
      return;
    }
    await refreshHealth();
  };
  const requestNotifications = async () => { await Notifications.requestPermissionsAsync(); await refreshHealth(); };
  const openLocationSettings = async () => { if (Platform.OS === 'android') await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.LOCATION_SOURCE_SETTINGS); else await Linking.openSettings(); await refreshHealth(); };

  const checkRows: { key: keyof typeof checks; title: string; detail: string; action: () => void; actionLabel: string; critical: boolean }[] = [
    { key: 'always', title: t('healthAlwaysTitle'), detail: t('healthAlwaysDetail'), action: () => void beginLocationFlow(), actionLabel: t('fix'), critical: true },
    { key: 'precise', title: t('healthPreciseTitle'), detail: t('healthPreciseDetail'), action: () => void beginLocationFlow(), actionLabel: t('fix'), critical: true },
    { key: 'gps', title: t('healthGpsTitle'), detail: t('healthGpsDetail'), action: () => void openLocationSettings(), actionLabel: t('openSettings'), critical: true },
    { key: 'notifications', title: t('healthNotificationsTitle'), detail: t('healthNotificationsDetail'), action: () => void requestNotifications(), actionLabel: t('fix'), critical: false },
    { key: 'internet', title: t('healthInternetTitle'), detail: t('healthInternetDetail'), action: () => void refreshHealth(), actionLabel: t('checkAgain'), critical: false },
    { key: 'battery', title: t('healthBatteryTitle'), detail: t('healthBatteryDetail'), action: () => void openBatterySettings(), actionLabel: t('openSettings'), critical: false }
  ];
  const criticalReady = checks.always === 'ok' && checks.precise === 'ok' && checks.gps === 'ok';

  if (loading) return <View style={styles.center}><ActivityIndicator color={colors.primary} /><Text style={styles.body}>{t('loading')}</Text></View>;
  const renderStop = ({ item, drag, isActive }: RenderItemParams<Child>) => <Pressable onLongPress={drag} disabled={isActive} style={[styles.stopRow, isActive && styles.dragging]} accessibilityRole="button" accessibilityLabel={t('dragStop', { name: item.name })}>
    <Text style={styles.dragHandle}>⠿</Text><View style={styles.stopText}><Text style={styles.childName}>{item.name}</Text><Text style={styles.caption}>{item.class || t('noClass')} · {item.parentPhone || t('noParentPhone')}</Text></View><Pressable accessibilityRole="button" accessibilityLabel={t('editChild')} hitSlop={8} onPress={() => editChild(item)}><Text style={styles.actionText}>{t('edit')}</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={t('removeChild')} hitSlop={8} onPress={() => void removeChild(item.id)}><Text style={styles.removeText}>{t('remove')}</Text></Pressable>
  </Pressable>;

  return <View style={styles.wrap}>
    <View style={styles.tabs}>{(['trip', 'van', 'children', 'health'] as const).map(tab => <Pressable key={tab} onPress={() => setSection(tab)} style={[styles.tab, section === tab && styles.activeTab]} accessibilityRole="tab" accessibilityState={{ selected: section === tab }}><Text style={[styles.tabText, section === tab && styles.activeTabText]}>{t(`driverTab_${tab}`)}</Text></Pressable>)}</View>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {section === 'van' && <Card style={styles.card}><Text style={styles.title}>{t('driverSetupTitle')}</Text><Text style={styles.body}>{t('driverSetupHelp')}</Text>
        <Field label={t('vanNumber')} value={van.number ?? ''} onChangeText={number => setVan(prev => ({ ...prev, number }))} placeholder={t('vanNumberPlaceholder')} />
        <Field label={t('vanName')} value={van.name ?? ''} onChangeText={name => setVan(prev => ({ ...prev, name }))} placeholder={t('vanNamePlaceholder')} />
        <Field label={t('vanSeats')} value={van.seats ? String(van.seats) : ''} onChangeText={value => setVan(prev => ({ ...prev, seats: Number(value) }))} keyboardType="number-pad" placeholder="1" />
        <Field label={t('schoolName')} value={schoolName} onChangeText={setSchoolName} placeholder={t('schoolNamePlaceholder')} />
        <PinPicker title={t('schoolPin')} pin={schoolPin} onChange={setSchoolPin} />
        <Field label={t('emergencyPhone')} value={van.emergencyPhone ?? ''} onChangeText={emergencyPhone => setVan(prev => ({ ...prev, emergencyPhone }))} keyboardType="phone-pad" placeholder={t('phonePlaceholder')} />
        <Button label={saving ? t('saving') : t('saveVanSetup')} onPress={() => void saveVan()} />
      </Card>}
      {section === 'trip' && <DriverTripFlow vanId={vanId} onOpenHealth={() => setSection('health')} />}
      {section === 'children' && <View style={styles.stack}>
        <Card style={styles.card}><Text style={styles.title}>{t('childrenTitle')}</Text><Text style={styles.body}>{t('childrenHelp')}</Text>
          <View style={styles.row}>{(['morningOrder', 'afternoonOrder'] as const).map((kind, index) => <Button key={kind} label={t(index === 0 ? 'morningStops' : 'afternoonStops')} variant={stopType === kind ? 'primary' : 'secondary'} onPress={() => setStopType(kind)} style={styles.growButton} />)}</View>
          {ordered.length ? <DraggableFlatList data={ordered} keyExtractor={item => item.id} renderItem={renderStop} onDragEnd={({ data }) => void reorderStops({ data })} scrollEnabled={false} /> : <Text style={styles.body}>{t('childrenEmpty')}</Text>}
        </Card>
        <Card style={styles.card}><Text style={styles.title}>{editingId ? t('editChild') : t('addChild')}</Text>
          <Field label={t('childName')} value={childName} onChangeText={setChildName} placeholder={t('childNamePlaceholder')} />
          <Field label={t('classLabel')} value={childClass} onChangeText={setChildClass} placeholder={t('classPlaceholder')} />
          <Field label={t('parentPhoneLabel')} value={parentPhone} onChangeText={setParentPhone} keyboardType="phone-pad" placeholder={t('phonePlaceholder')} />
          <PinPicker title={t('homePin')} pin={homePin} onChange={setHomePin} />
          <Button label={saving ? t('saving') : t(editingId ? 'saveChild' : 'addChild')} onPress={() => void saveChild()} />
          {editingId && <Button label={t('cancelEdit')} variant="secondary" onPress={clearChildDraft} />}
        </Card>
      </View>}
      {section === 'health' && <View style={styles.stack}><Card style={styles.card}><Text style={styles.title}>{t('healthTitle')}</Text><Text style={styles.body}>{t('healthHelp')}</Text>
        {checkRows.map(row => <View key={row.key} style={styles.checkRow}><View style={styles.checkCopy}><Text style={styles.childName}>{row.title}</Text><Text style={styles.caption}>{row.detail}</Text><Text style={[styles.checkState, checks[row.key] === 'ok' ? styles.ok : checks[row.key] === 'needs' ? styles.needs : styles.warn]}>{t(checks[row.key] === 'ok' ? 'checkPassed' : row.key === 'battery' && batteryConfirmed ? 'batteryReviewed' : 'checkNeedsAttention')}</Text></View><Button label={row.actionLabel} variant="secondary" onPress={() => { if (row.key === 'battery' && batteryConfirmed) return; row.action(); }} style={styles.smallButton} /></View>)}
        {permissionStep !== 'none' && <View style={styles.rationale}><Text style={styles.childName}>{t(permissionStep === 'foregroundRationale' ? 'foregroundRationaleTitle' : 'backgroundRationaleTitle')}</Text><Text style={styles.body}>{t(permissionStep === 'foregroundRationale' ? 'foregroundRationaleBody' : 'backgroundRationaleBody')}</Text><Button label={t('continue')} onPress={() => void continueLocationFlow()} /></View>}
      </Card><Card style={styles.readiness}><Text style={styles.title}>{t(criticalReady ? 'healthReadyTitle' : 'healthBlockedTitle')}</Text><Text style={styles.body}>{t(criticalReady ? 'healthReadyBody' : 'healthBlockedBody')}</Text><Button label={t('checkAgain')} variant="secondary" onPress={() => void refreshHealth()} /></Card>
      {Platform.OS === 'android' && <Card style={styles.card}><Text style={styles.childName}>{t('batteryGuideTitle')}</Text><Text style={styles.body}>{t('batteryGuideBody')}</Text>
        {(['xiaomi', 'vivo', 'samsung'] as const).map(device => <Button key={device} label={t(`batteryHelp_${device}`)} variant="secondary" onPress={() => setDeviceHelp(current => current === device ? null : device)} />)}
        {deviceHelp && <View style={styles.rationale}><Text style={styles.childName}>{t(`batteryHelp_${deviceHelp}`)}</Text><Text style={styles.body}>{t(`batterySteps_${deviceHelp}`)}</Text></View>}
        <Button label={t(batteryConfirmed ? 'batteryReviewed' : 'confirmBatterySetup')} onPress={() => { setBatteryConfirmed(true); setChecks(prev => ({ ...prev, battery: 'ok' })); }} variant="secondary" /></Card>}</View>}
      {errorKey && <Text accessibilityRole="alert" style={styles.error}>{t(errorKey)}</Text>}
      <View style={styles.stack}><Text style={styles.childName}>{t('privacyTitle')}</Text><Text style={styles.body}>{t('privacyBody')}</Text><Text style={styles.body}>{t('privacyLocation')}</Text><Text style={styles.body}>{t('privacyRetention')}</Text><Text style={styles.body}>{t('privacyMapProvider')}</Text><Text style={styles.body}>{t('privacyChoice')}</Text><Text style={styles.caption}>{t('privacyPolicyLocation')}</Text><Button label={t('privacyPolicyOpen')} variant="secondary" onPress={openPrivacyPolicy} /></View>
      <Button label={t('deleteAccount')} variant="secondary" onPress={onDeleteAccount} />
      <Button label={t('signOut')} variant="secondary" onPress={onSignOut} />
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({ wrap: { flex: 1, gap: spacing.sm }, tabs: { flexDirection: 'row', borderBottomWidth: 1, borderColor: colors.hairline }, tab: { flex: 1, minHeight: 48, justifyContent: 'center', alignItems: 'center', borderBottomWidth: 2, borderColor: 'transparent' }, activeTab: { borderColor: colors.primary }, tabText: { color: colors.mutedInk, fontSize: type.caption.size, fontWeight: '600' }, activeTabText: { color: colors.primary }, content: { gap: spacing.md, paddingBottom: spacing.xl }, card: { gap: spacing.sm }, stack: { gap: spacing.md }, title: { color: colors.ink, fontSize: type.tagline.size, lineHeight: type.tagline.lineHeight, fontWeight: '600' }, body: { color: colors.mutedInk, fontSize: type.body.size, lineHeight: type.body.lineHeight }, caption: { color: colors.mutedInk, fontSize: type.caption.size, lineHeight: type.caption.lineHeight }, label: { color: colors.ink, fontSize: type.caption.size, fontWeight: '600' }, field: { gap: spacing.xs }, input: { minHeight: 50, paddingHorizontal: spacing.md, borderRadius: 11, borderColor: colors.hairline, borderWidth: 1, backgroundColor: colors.pearl, color: colors.ink, fontSize: type.body.size }, pinBox: { gap: spacing.xs }, map: { height: 210, borderRadius: 12, overflow: 'hidden' }, mapMissing: { backgroundColor: colors.parchment, alignItems: 'center', justifyContent: 'center', padding: spacing.md }, pinDot: { width: 20, height: 20, borderRadius: 10, borderColor: colors.bodyOnDark, borderWidth: 3, backgroundColor: colors.primary }, pinSelected: { color: colors.mutedInk, fontSize: type.caption.size }, rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, row: { flexDirection: 'row', gap: spacing.xs }, smallButton: { minHeight: 44, paddingHorizontal: spacing.md }, growButton: { flex: 1, paddingHorizontal: spacing.xs }, stopRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, borderBottomWidth: 1, borderColor: colors.hairline }, dragging: { backgroundColor: colors.parchment }, dragHandle: { fontSize: 24, color: colors.mutedInk, paddingHorizontal: spacing.xs }, stopText: { flex: 1 }, childName: { color: colors.ink, fontSize: type.bodyStrong.size, lineHeight: type.bodyStrong.lineHeight, fontWeight: '600' }, actionText: { color: colors.primary, fontSize: type.caption.size, fontWeight: '600' }, removeText: { color: colors.danger, fontSize: type.caption.size, fontWeight: '600' }, checkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: 1, borderColor: colors.hairline }, checkCopy: { flex: 1, gap: 2 }, checkState: { fontSize: type.caption.size, fontWeight: '600' }, ok: { color: colors.success }, needs: { color: colors.warning }, warn: { color: colors.warning }, rationale: { gap: spacing.sm, padding: spacing.md, backgroundColor: colors.parchment, borderRadius: 12 }, readiness: { gap: spacing.sm, borderColor: colors.primary, borderWidth: 1 }, center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: spacing.sm }, error: { color: colors.danger, fontSize: type.body.size }, batteryGuideTitle: { color: colors.ink, fontSize: type.bodyStrong.size, fontWeight: '600' } });
