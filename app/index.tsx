import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Linking, Platform, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { doc, getDoc } from '@react-native-firebase/firestore';
import { getAuth, onAuthStateChanged, signInWithPhoneNumber, signOut } from '@react-native-firebase/auth';
import { httpsCallable } from '@react-native-firebase/functions';
import { auth, firestore, functions } from '../src/shared/firebase/client';
import { Button } from '../src/shared/ui/Button';
import { Card } from '../src/shared/ui/Card';
import { colors, spacing, type } from '../src/shared/theme/tokens';
import { DriverSetupFlow } from '../src/driver/DriverSetupFlow';
import { ParentHome } from '../src/parent/ParentHome';
import { unregisterPushNotifications } from '../src/shared/notifications/push';

type Role = 'driver' | 'parent';
type Step = 'phone' | 'code' | 'consent' | 'setup' | 'ready';
type OnboardingData = { role: Role; language: 'en' | 'hi'; name: string };
type OnboardingResponse = { role: Role; language: 'en' | 'hi'; vanId?: string };
type Confirmation = Awaited<ReturnType<typeof signInWithPhoneNumber>>;
type SignedInUser = NonNullable<ReturnType<typeof getAuth>['currentUser']>;
const privacyConsentVersion = '2026-10-11';
const privacyPolicyURL = process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL;

function friendlyError(error: unknown, fallback: string): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'functions/permission-denied') return 'driverNeedsApproval';
  if (code === 'functions/failed-precondition') return 'roleMismatch';
  return fallback;
}

export default function WelcomeScreen() {
  const { t, i18n } = useTranslation();
  const [step, setStep] = useState<Step>('phone');
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [currentUser, setCurrentUser] = useState<SignedInUser | null>(null);
  const [driverVanId, setDriverVanId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => onAuthStateChanged(auth, user => {
    setCurrentUser(user);
    if (!user) {
      setStep('phone');
      setCheckingAuth(false);
      return;
    }
    void (async () => {
      try {
        const profile = await getDoc(doc(firestore, 'users', user.uid));
        const data = profile.data();
          if (data?.privacyConsentVersion !== privacyConsentVersion) {
            setStep('consent');
          } else if (data?.role === 'driver' || data?.role === 'parent') {
          setRole(data.role);
          setDriverVanId(data.role === 'driver' && Array.isArray(data.vanIds) ? data.vanIds[0] ?? null : null);
          if (data.language === 'en' || data.language === 'hi') void i18n.changeLanguage(data.language);
          setStep('ready');
        } else {
          setStep('setup');
        }
      } catch {
        setErrorKey('setupFailed');
        setStep('setup');
      } finally {
        setCheckingAuth(false);
      }
    })();
  }), [i18n]);

  const toggleLanguage = () => { void i18n.changeLanguage(i18n.language === 'en' ? 'hi' : 'en'); };
  const normalizePhone = () => phone.trim().replace(/[\s()-]/g, '');

  const sendCode = async () => {
    const normalized = normalizePhone();
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
      setErrorKey('phoneInvalid');
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      const result = await signInWithPhoneNumber(auth, normalized);
      setPhone(normalized);
      setConfirmation(result);
      setStep('code');
    } catch {
      setErrorKey('otpFailed');
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    if (!confirmation || !/^\d{6}$/.test(code.trim())) {
      setErrorKey('codeInvalid');
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      const credential = await confirmation.confirm(code.trim());
      if (!credential?.user) throw new Error('missing-auth-user');
      setCurrentUser(credential.user);
      const profile = await getDoc(doc(firestore, 'users', credential.user.uid));
      const data = profile.data();
      if (data?.privacyConsentVersion !== privacyConsentVersion) {
        setStep('consent');
      } else if (data?.role === 'driver' || data?.role === 'parent') {
        setRole(data.role);
        setDriverVanId(data.role === 'driver' && Array.isArray(data.vanIds) ? data.vanIds[0] ?? null : null);
        if (data.language === 'en' || data.language === 'hi') void i18n.changeLanguage(data.language);
        setStep('ready');
      } else {
        setStep('setup');
      }
    } catch {
      setErrorKey('codeFailed');
    } finally {
      setBusy(false);
    }
  };

  const finishSetup = async () => {
    if (!name.trim()) {
      setErrorKey('nameRequired');
      return;
    }
    if (!role) {
      setErrorKey('roleRequired');
      return;
    }
    if (!currentUser) {
      setErrorKey('setupFailed');
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      const call = httpsCallable<OnboardingData & { privacyConsentVersion: string }, OnboardingResponse>(functions, 'finishOnboarding');
      const response = await call({ role, language: i18n.language === 'hi' ? 'hi' : 'en', name: name.trim(), privacyConsentVersion });
      setDriverVanId(response.data.vanId ?? null);
      setStep('ready');
    } catch (error) {
      setErrorKey(friendlyError(error, 'setupFailed'));
    } finally {
      setBusy(false);
    }
  };

  const acceptPrivacy = async () => {
    if (!currentUser) return;
    setBusy(true); setErrorKey(null);
    try {
      const profile = await getDoc(doc(firestore, 'users', currentUser.uid));
      if (profile.exists()) await httpsCallable(functions, 'recordPrivacyConsent')({ version: privacyConsentVersion });
      if (profile.data()?.role === 'driver' || profile.data()?.role === 'parent') {
        setRole(profile.data()?.role as Role);
        setDriverVanId(profile.data()?.role === 'driver' && Array.isArray(profile.data()?.vanIds) ? profile.data()?.vanIds[0] ?? null : null);
        setStep('ready');
      } else setStep('setup');
    } catch { setErrorKey('privacyConsentFailed'); }
    finally { setBusy(false); }
  };

  const handleDeleteAccount = () => Alert.alert(t('deleteAccount'), t('deleteAccountConfirm'), [
    { text: t('cancel'), style: 'cancel' },
    { text: t('deleteAccount'), style: 'destructive', onPress: () => void (async () => {
      if (!currentUser) return;
      setBusy(true);
      try {
        await unregisterPushNotifications(currentUser.uid);
        await httpsCallable(functions, 'deleteAccountData')({});
        await signOut(auth);
      } catch { setErrorKey('deleteAccountError'); }
      finally { setBusy(false); }
    })() }
  ]);

  const openPrivacyPolicy = () => {
    if (!privacyPolicyURL?.startsWith('https://')) { Alert.alert(t('privacyTitle'), t('privacyPolicyLocation')); return; }
    void Linking.openURL(privacyPolicyURL).catch(() => Alert.alert(t('privacyTitle'), t('privacyPolicyLocation')));
  };

  const handleSignOut = async () => {
    setBusy(true);
    setErrorKey(null);
    try {
      if (currentUser) await unregisterPushNotifications(currentUser.uid);
      await signOut(auth);
      setPhone('');
      setCode('');
      setName('');
      setRole(null);
      setDriverVanId(null);
      setConfirmation(null);
    } catch {
      setErrorKey('setupFailed');
    } finally {
      setBusy(false);
    }
  };

  if (checkingAuth) return <SafeAreaView style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.body}>{t('loading')}</Text></SafeAreaView>;

  return <SafeAreaView style={styles.safe}>
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.top}>
          <Text style={styles.brand}>{t('brand')}</Text>
          <Button label={i18n.language === 'en' ? t('hindi') : t('english')} variant="secondary" onPress={toggleLanguage} style={styles.languageButton} />
        </View>
        <Card style={styles.hero}>
          <View style={styles.routeLine}><View style={styles.routePoint} /><View style={styles.routeDash} /><View style={styles.routePointEnd} /></View>
          <Text style={styles.headline}>{t('welcome')}</Text>
          {step === 'phone' && <Text style={styles.body}>{t('phoneHelp')}</Text>}
        </Card>

        {step === 'phone' && <Card style={styles.form}>
          <Text style={styles.title}>{t('phoneTitle')}</Text>
          <TextInput value={phone} onChangeText={setPhone} placeholder={t('phonePlaceholder')} keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" maxLength={24} style={styles.input} accessibilityLabel={t('phoneTitle')} />
          <Button label={busy ? t('sendingCode') : t('sendCode')} onPress={() => void sendCode()} />
        </Card>}

        {step === 'code' && <Card style={styles.form}>
          <Text style={styles.title}>{t('codeTitle')}</Text>
          <Text style={styles.body}>{t('codeHelp', { phone })}</Text>
          <TextInput value={code} onChangeText={setCode} placeholder={t('codePlaceholder')} keyboardType="number-pad" autoComplete="sms-otp" textContentType="oneTimeCode" maxLength={6} style={styles.input} accessibilityLabel={t('codeTitle')} />
          <Button label={busy ? t('checkingCode') : t('verifyCode')} onPress={() => void verifyCode()} />
          <Button label={t('resendCode')} variant="secondary" onPress={() => void sendCode()} />
        </Card>}

        {step === 'consent' && <Card style={styles.form}>
          <Text style={styles.title}>{t('privacyTitle')}</Text>
          <Text style={styles.body}>{t('privacyBody')}</Text>
          <Text style={styles.body}>{t('privacyLocation')}</Text>
          <Text style={styles.body}>{t('privacyRetention')}</Text>
          <Text style={styles.body}>{t('privacyMapProvider')}</Text>
          <Text style={styles.body}>{t('privacyChoice')}</Text>
          <Text style={styles.body}>{t('privacyPolicyLocation')}</Text>
          <Button label={t('privacyPolicyOpen')} variant="secondary" onPress={openPrivacyPolicy} />
          <Button label={busy ? t('loading') : t('privacyAccept')} onPress={() => void acceptPrivacy()} />
          <Button label={t('signOut')} variant="secondary" onPress={() => void handleSignOut()} />
        </Card>}

        {step === 'setup' && <Card style={styles.form}>
          <Text style={styles.title}>{t('chooseRole')}</Text>
          <Text style={styles.label}>{t('nameLabel')}</Text>
          <TextInput value={name} onChangeText={setName} placeholder={t('namePlaceholder')} autoComplete="name" textContentType="name" maxLength={80} style={styles.input} accessibilityLabel={t('nameLabel')} />
          <Text style={styles.label}>{t('chooseLanguage')}</Text>
          <View style={styles.roles}>
            <Button label={t('english')} variant={i18n.language === 'en' ? 'primary' : 'secondary'} onPress={() => void i18n.changeLanguage('en')} style={styles.roleButton} />
            <Button label={t('hindi')} variant={i18n.language === 'hi' ? 'primary' : 'secondary'} onPress={() => void i18n.changeLanguage('hi')} style={styles.roleButton} />
          </View>
          <Text style={styles.label}>{t('rolePrompt')}</Text>
          <View style={styles.roles}>
            <Button label={t('parent')} variant={role === 'parent' ? 'primary' : 'secondary'} onPress={() => setRole('parent')} style={styles.roleButton} />
            <Button label={t('driver')} variant={role === 'driver' ? 'primary' : 'secondary'} onPress={() => setRole('driver')} style={styles.roleButton} />
          </View>
          {role && <Text style={styles.body}>{t(role === 'driver' ? 'driverRoleHelp' : 'parentRoleHelp')}</Text>}
          <Button label={busy ? t('savingProfile') : t('finishSetup')} onPress={() => void finishSetup()} />
        </Card>}

        {step === 'ready' && role === 'driver' && <View style={styles.driverFlow}><DriverSetupFlow vanId={driverVanId} onSignOut={() => void handleSignOut()} onDeleteAccount={handleDeleteAccount} /></View>}

        {step === 'ready' && role === 'parent' && <View style={styles.parentFlow}><ParentHome onSignOut={() => void handleSignOut()} onDeleteAccount={handleDeleteAccount} /></View>}
        {step === 'ready' && !role && <Card style={styles.form}><Text style={styles.title}>{t('readyTitle')}</Text><Button label={busy ? t('loading') : t('signOut')} variant="secondary" onPress={() => void handleSignOut()} /></Card>}

        {errorKey && <Text accessibilityRole="alert" style={styles.error}>{t(errorKey)}</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.parchment }, flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: colors.parchment },
  page: { flexGrow: 1, gap: spacing.md, padding: spacing.lg },
  driverFlow: { flex: 1, minHeight: 600, gap: spacing.md }, parentFlow: { flex: 1, minHeight: 650 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { fontSize: 20, fontWeight: '600', letterSpacing: -0.4, color: colors.ink },
  languageButton: { minHeight: 44, paddingHorizontal: spacing.md },
  hero: { borderWidth: 0, borderRadius: 0, backgroundColor: colors.tile, minHeight: 170, justifyContent: 'flex-end', gap: spacing.sm },
  routeLine: { flexDirection: 'row', alignItems: 'center', marginBottom: 'auto' },
  routePoint: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.primaryOnDark },
  routePointEnd: { width: 14, height: 14, borderRadius: 7, borderWidth: 3, borderColor: colors.bodyOnDark },
  routeDash: { flex: 1, height: 1, backgroundColor: colors.bodyMuted, marginHorizontal: spacing.sm },
  headline: { color: colors.bodyOnDark, fontSize: type.title.size, lineHeight: type.title.lineHeight, fontWeight: '600', letterSpacing: type.title.tracking },
  title: { color: colors.ink, fontSize: type.tagline.size, lineHeight: type.tagline.lineHeight, fontWeight: '600' },
  roleName: { color: colors.primary, fontSize: type.bodyStrong.size, fontWeight: '600' },
  body: { color: colors.mutedInk, fontSize: type.body.size, lineHeight: type.body.lineHeight },
  label: { color: colors.ink, fontSize: type.caption.size, fontWeight: '600', marginTop: spacing.xs },
  form: { gap: spacing.sm },
  input: { minHeight: 52, paddingHorizontal: spacing.md, borderRadius: 11, borderColor: colors.hairline, borderWidth: 1, backgroundColor: colors.pearl, color: colors.ink, fontSize: type.body.size },
  roles: { flexDirection: 'row', gap: spacing.sm },
  roleButton: { flex: 1 },
  error: { color: colors.danger, fontSize: type.body.size, lineHeight: type.body.lineHeight, paddingHorizontal: spacing.xs }
});
