# VanSathi

VanSathi is a bilingual school van tracker for drivers and parents in India, built on Expo SDK 57. Milestones 1–8 are implemented. Drivers manage vans, children and trips; parents follow linked trips, manage absences and receive notifications. Hardening adds privacy consent, data deletion, App Check, Crashlytics and device-specific battery help. Real-device reliability checks remain to be completed; see the manual checklist below.

## Requirements

- Node.js 22.13+ and npm (required by the current stable Expo SDK)
- EAS CLI for development builds
- Firebase CLI and a Firebase project for native credentials and deploys
- Android Studio/Xcode for local device builds

## Local setup

1. Copy `.env.example` to `.env` and fill project, map style, and HTTPS privacy-policy URL configuration. The policy must identify the service operator and actual map provider before release. For Auth, Firestore, and Functions emulators, set `EXPO_PUBLIC_USE_FIREBASE_EMULATORS=true` and select a reachable host for your simulator or device.
2. Add `google-services.json` and `GoogleService-Info.plist` from the Firebase project; these are ignored by git.
3. Run `npm ci` and `npm --prefix functions ci`.
4. Run `npx expo prebuild` and `npx expo run:android` or `npx expo run:ios` for a native development build. Expo Go is not supported for the required native Firebase/background-location behavior.
5. Enable Phone sign-in in Firebase Authentication and add the Android SHA fingerprints used by the EAS development build. Configure test phone numbers for emulator/manual testing.
6. Run `npx firebase emulators:start --only auth,firestore,database,functions,pubsub`. Emulator ports are defined in `firebase.json`; `npm run test:rules` starts Firestore and RTDB emulators and executes the rule tests.
7. Before activating a driver, create `driverApprovals/{E.164 phone}` in the Firebase Console with `{ active: true, vanId: "..." }`. Driver role selection alone does not grant access.
8. Register Android apps for Play Integrity and Apple apps for App Attest with DeviceCheck fallback in Firebase App Check. Development builds use the debug provider; register each development device's debug token in Firebase Console. Review App Check metrics first, then enforce Firestore, Realtime Database and Cloud Functions after valid tokens appear. Emulator runs do not verify production enforcement.
9. Enable Crashlytics for each Firebase app. Collection is disabled in development builds and enabled in release builds. Do not add user IDs, phone numbers, child names or location data as Crashlytics attributes.
10. Review `PRIVACY_POLICY.md` in English and Hindi, replace its release contact and map-provider instructions, publish it at an HTTPS URL, and set `EXPO_PUBLIC_PRIVACY_POLICY_URL` to that URL before publishing the app. Publish a separate account-deletion web page using [ACCOUNT_DELETION_PAGE.md](ACCOUNT_DELETION_PAGE.md) and enter its URL in Play Console; the in-app deletion button alone does not meet Play's web deletion requirement.

Native Firebase SDKs use the platform config files; client-visible Firebase project values are configuration, not secrets. Never commit private service-account keys. `EXPO_PUBLIC_MAP_STYLE_URL` must point to a production tile/style provider; public OpenStreetMap tile servers are not a production provider.

Driver setup uses Expo Location, Notifications, Network and Intent Launcher with MapLibre. A production map style URL is required to tap a map for pins; current-location pins remain available when no map style is configured. Battery optimization status cannot be read reliably through Expo, so the health check opens Android battery settings and asks the driver to confirm the setting. It does not request the broad battery exemption permission. Trip state and route coordinates are persisted in an SQLCipher encrypted SQLite database, with its key and active-trip pointer stored in SecureStore; stop actions, geofence hints, sampled breadcrumbs and trip finish operations use a bounded ordered queue. Live positions are not queued. `EXPO_PUBLIC_VAN_NEAR_METERS` sets the client-side approach radius (default 500 m, capped at 5 km).

## Checks

Run `npm run check:locales`, `npm run typecheck`, `npm run typecheck:functions`, `npm run lint`, `npm test`, `npm run test:rules`, or `npm run ci`. CI compiles app and functions code, runs pure trip-engine tests, and checks Firestore/Realtime Database rules.

`npm audit` still reports 87 dependency advisories (18 moderate, 69 high) across the current dependency tree. A non-forcing audit fix was applied; remaining suggested automatic fixes include breaking Expo/Firebase downgrades. Review and resolve these before a pilot or store release.

## EAS development build

Configure the EAS project with `eas project:init`, then run `eas build --profile development --platform android` (or `ios`). Credentials and application identifiers must be configured for the pilot's Firebase/EAS projects before a device build.

## Firebase deploy

Firebase project selection and credentials are pilot-specific. `.firebaserc` points to a demo emulator project; replace it with the real pilot project before deployment. After configuring the CLI project, deploy with `firebase deploy --only firestore:rules,firestore:indexes,database,functions`. `firestore.indexes.json` contains parent history, active-trip, absence and breadcrumb cleanup indexes. Enable App Check enforcement separately in Firebase Console after reviewing metrics. Scheduled functions need Cloud Scheduler/Pub/Sub and a billing-enabled Firebase project.

## Cost controls

Set a billing budget alert in the Firebase/Google Cloud billing account before pilot usage. Realtime Database stores only the current location; Firestore breadcrumbs are sampled every 30 seconds and deleted after 30 days. Scheduled abandoned-trip checks run every five minutes.

## Milestone status

Milestones 1–3 created the Expo foundation, OTP and roles, security rules, driver setup, children and stop ordering, and the bilingual Setup Health Check. Milestone 4 adds the tested trip state machine, server-owned trip transitions, adaptive background location, latest-position RTDB updates, sampled breadcrumbs, encrypted local recovery state and ordered offline queue. Milestone 5 adds parent home, active-trip map, stale-location handling, distance/rough ETA, driver calls, absence requests, recent events, language and notification preferences. Milestone 6 adds proximity hints, bilingual push notifications, emergency alerts, India-local absence pre-marking, abandoned-trip monitoring and breadcrumb cleanup. Milestone 7 adds bilingual privacy consent and policy, account deletion, App Check initialization, release-only Crashlytics, OEM battery help and the manual test guide. Milestone 8 adds the current Play declaration checklist, provisional Data safety answers, deletion release gates, and English/Hindi store listing drafts in [PLAY_STORE_PREP.md](PLAY_STORE_PREP.md). The active deletion URL, operator/map-provider identity, Firebase Console enforcement, production push/scheduler, and physical-device test evidence still need pilot setup. A signed store bundle has not been built or submitted.

## Manual device checklist

Record device model, OS version, app build, date and pass/fail notes for each run. These physical-device checks have **not yet been run**:

- Xiaomi/Redmi, Samsung and one low-end Android phone: grant permissions, apply the matching battery guide, start a trip, lock the screen for 30 minutes, and verify location timestamps and parent updates continue.
- During a trip, toggle airplane mode for two minutes, move through multiple stops, restore connectivity, and verify queued events and breadcrumbs upload in order while live location resumes from the newest fix.
- With a trip active, force-stop and relaunch the app; record actual recovery and any Android force-stop restart requirement.
- Begin below 20% battery, verify the low-battery message, and confirm tracking remains active while charging.
- Deny foreground/background location and notification permissions, verify settings links, then grant them and confirm only critical location/GPS failures block trip start.
- Register App Check test devices, review metrics before enforcement, send test pushes in foreground/background, and verify invalid FCM tokens are removed.
- Verify parent deletion removes absence requests and unlinks children; verify driver deletion is blocked for active trips and removes that van's data after trip end.

Record observed results before treating any device check as passed.
