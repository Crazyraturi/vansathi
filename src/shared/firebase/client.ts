import { getApp } from '@react-native-firebase/app';
import { connectAuthEmulator, getAuth } from '@react-native-firebase/auth';
import { connectFirestoreEmulator, getFirestore } from '@react-native-firebase/firestore';
import { connectDatabaseEmulator, getDatabase } from '@react-native-firebase/database';
import { connectFunctionsEmulator, getFunctions } from '@react-native-firebase/functions';
import { initializeAppCheck } from '@react-native-firebase/app-check';
import { getCrashlytics, setCrashlyticsCollectionEnabled } from '@react-native-firebase/crashlytics';

const app = getApp();
export const auth = getAuth(app);
export const firestore = getFirestore(app);
export const realtime = getDatabase(app);
export const functions = getFunctions(app, 'asia-south1');

try {
  initializeAppCheck(app, {
    provider: { providerOptions: {
      android: { provider: __DEV__ ? 'debug' : 'playIntegrity' },
      apple: { provider: __DEV__ ? 'debug' : 'appAttestWithDeviceCheckFallback' }
    } },
    isTokenAutoRefreshEnabled: true
  });
} catch {
  // Native App Check providers are configured by the platform Firebase project.
}

const crashlytics = getCrashlytics(app);
void setCrashlyticsCollectionEnabled(crashlytics, !__DEV__).catch(() => undefined);

if (__DEV__ && process.env.EXPO_PUBLIC_USE_FIREBASE_EMULATORS === 'true') {
  const host = process.env.EXPO_PUBLIC_FIREBASE_EMULATOR_HOST || 'localhost';
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(firestore, host, 8080);
  connectDatabaseEmulator(realtime, host, 9000);
  connectFunctionsEmulator(functions, host, 5001);
}
