# Google Play release preparation

Prepared 11 October 2026 for package `com.vansathi.app`. Treat the Data safety and declaration text below as a draft. Reconcile it against the final signed Android App Bundle, the configured map provider, Firebase SDK behavior, and the live Play Console forms before submission.

## Release gates

- Publish the bilingual privacy notice at an active HTTPS URL that names the actual developer/operator and configured map-tile provider; link that same URL inside the app and on the store listing. `PRIVACY_POLICY.md` still has an operator-contact instruction to replace.
- Google Play requires an external account deletion request page as well as in-app deletion. Implementing the in-app button is not enough. Host a functional page that clearly names VanSathi and lets users request deletion without reinstalling the app; submit its URL in Play Console. [ACCOUNT_DELETION_PAGE.md](ACCOUNT_DELETION_PAGE.md) is ready-to-publish page copy and a checklist, but no host/domain was provided, so this project does not yet have a live endpoint.
- As of 31 August 2026, new apps and updates must target Android 16 / API 36 or higher. The installed React Native Gradle version catalog sets `targetSdk = 36`; still inspect the generated native Gradle config and the signed AAB before submission.
- Check the final merged manifest for exactly the permissions needed. Expo Location is configured for background location and a location foreground service; Android config now blocks legacy external-storage permissions. Verify the merged manifest confirms those storage permissions are absent and that `ACCESS_BACKGROUND_LOCATION`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, and `POST_NOTIFICATIONS` appear only as intended.
- Complete Play Console App content declarations, provide review credentials for both driver and parent roles, and keep the driver account/van active during review. Do not submit until a real Android device demonstrates the disclosure, permission sequence, active trip notification, and stop behavior.
- No real device or Play Console review has been performed in this workspace.

## Permissions and foreground service declarations

### Background location declaration

Declare one core feature: **driver-initiated live school-van trip tracking for linked parents**. The driver taps Start Trip, sees a persistent tracking notification, and the app shares the latest van position with linked parents while the app is in the background or the screen is off. On-device proximity hints support stop/school arrival updates. Tracking stops when the driver ends the trip or the server abandons it. Background access is necessary because drivers must be able to lock the phone and continue the trip without keeping the app visible. Do not declare geofencing as a separate feature.

Use the Play Console sensitive location permission declaration, provide the prominent disclosure, and attach an Android video of 30 seconds or less. The video should show the driver opening the Setup Health Check, the in-app background-location disclosure, the Android runtime permission step, starting a trip, the persistent notification while the app is backgrounded, a parent-facing live location/update, and ending the trip. Use a real test account and redact actual child names, phone numbers, and home locations.

Draft declaration response:

> VanSathi is a school-van trip tracking app. A driver starts each trip in the app. During that active trip, background location keeps the van's live position available to the linked parents when the driver locks the screen or switches apps. The app also uses the same trip positions to detect a nearby pickup stop and school arrival, and to save sampled route history for up to 30 days. A persistent foreground-service notification tells the driver that location is being shared. Tracking stops when the trip ends. Location is not used for ads or analytics.

### Foreground service declaration

Declare the `location` foreground-service type for the user-started, ongoing trip-tracking action. Explain that it is visible through the persistent notification and stops on trip end. Attach the same concise video, making the user action and active trip visible. Verify the generated manifest uses the location type and the required Android 14+ service permission.

### Other permission notes

- `POST_NOTIFICATIONS`: used for the persistent driver trip notification and parent alerts. Explain the trip service and notifications in-app before requesting permission.
- `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION`: precise location is required for pickup pins and live trip tracking; the two-step rationale is in the driver health flow.
- Battery guidance opens Android settings; the app does not request `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
- There is no contact-list permission. One-tap calls open the system dialer using an app-stored phone number.

## Data safety form draft

Answer for the complete production build and every bundled SDK, not just the app's own code. Google treats data sent off-device by SDKs as collection; SDK and map-provider privacy behavior must be verified before final answers.

### Collection

| Play data type | Collected? | Purpose / notes |
|---|---:|---|
| Precise location | Yes | Driver's live trip location, child pickup pins, and school pin. App functionality; driver collection occurs during trip tracking, while pins remain until changed or the associated record is removed. Linked parents see the van's current position during an active trip and recent sampled route history. |
| Name | Yes | Driver, parent, and child display names; account and app functionality. |
| Phone number | Yes | Phone OTP account, parent-child linking, and driver/parent contact. |
| User IDs | Yes | Firebase account identifier and server-linked records. Account management and app functionality. |
| App activity / other actions | Yes | Trip, stop, absence, and notification preference records needed for tracking/history and alerts. Verify the exact Play Console subcategory when completing the form. |
| Device or other IDs | Yes | FCM registration token for push delivery and SDK-generated app/device identifiers; verify Firebase SDK declarations for the versions in the AAB. |
| App info and performance / crash logs | Yes | Release Crashlytics crash reports and technical diagnostics. Crashlytics collection is disabled in development builds. |

No advertising ID, ads, analytics SDK, contact list, SMS, call log, microphone, camera, or photo-library collection is intended. Recheck the final dependency/manifest inventory. A system dialer handoff is not access to the user's call history.

### Sharing, protection, and deletion

- Firebase services process account, trip, location, push-token, and crash data as configured service providers. Complete the form according to the actual Firebase terms and Play Console's service-provider treatment.
- Linked parents are authorized app users who receive trip location and events under the app's prominent disclosure and consent. Keep this user-to-user visibility explicit in the listing, in-app notice, and privacy policy.
- A configured map-tile provider receives map-tile requests for the visible viewport. Review the provider's SDK and terms, and disclose any location/identifier data it receives. Do not make a blanket “not shared” declaration until the map provider and all SDK transfers are verified.
- Claim “encrypted in transit” only after confirming every production endpoint, including map style/tile sources and Firebase SDKs, uses TLS. Map style URLs are now restricted to HTTPS, but inspect the URLs returned inside the configured style document too.
- Account creation: **Yes** (phone OTP and role setup). In-app account deletion: **Yes**. External deletion web resource: **Not ready**; publish and test a functional page before submission. Complete the Data deletion section and supply the active URL in Play Console.
- Route point retention: scheduled cleanup after 30 days. Account deletion removes the Firebase Auth account; parent deletion unlinks the parent, clears their phone from linked child contact records, and removes their absences. Driver deletion is blocked until active trips end and removes the driver's van data and history. Verify that this retention/deletion scope meets Play policy for all child-linked records before claiming full deletion.

## Store listing draft

### English

**App name:** VanSathi: School Van Tracker

**Short description:** Follow school-van trips live and get pickup, arrival, and drop-off alerts.

**Full description:**

VanSathi helps parents follow their child's school-van trip and helps drivers keep each school run organized.

Parents can:
- See the van's live location while a trip is active.
- Follow pickup, school arrival, and drop-off updates.
- Get alerts when the van is near a stop or when an emergency alert is sent.
- Report when a child will not ride on a selected date and trip.
- Call the assigned driver and review recent trip events.
- Choose English or Hindi and adjust notification preferences.

Drivers can:
- Set up the van, school, children, pickup points, and stop order.
- Start a morning or afternoon trip and record stop outcomes.
- Share the van's live location with linked parents during the trip, including when the phone screen is off.
- See trip and phone health guidance, including battery-use steps for common Android phones.
- Send an emergency alert to parents linked to the van.

Location sharing starts with a driver-started trip and ends when that trip is finished. Live updates depend on phone GPS, connectivity, and device power settings. Location is not collected for advertising.

### Hindi

**ऐप का नाम:** VanSathi: स्कूल वैन ट्रैकर

**छोटा विवरण:** स्कूल वैन की लाइव ट्रिप और पिकअप, स्कूल पहुँचने व ड्रॉप के अलर्ट।

**पूरा विवरण:**

VanSathi से पैरेंट बच्चे की स्कूल वैन की ट्रिप देख सकते हैं और ड्राइवर स्कूल के सफ़र को व्यवस्थित रख सकते हैं।

पैरेंट कर सकते हैं:
- ट्रिप चालू रहने पर वैन की लाइव लोकेशन देखना।
- पिकअप, स्कूल पहुँचने और ड्रॉप के अपडेट देखना।
- वैन के स्टॉप के पास आने और इमरजेंसी अलर्ट की सूचना पाना।
- चुनी हुई तारीख और ट्रिप के लिए बताना कि बच्चा वैन में नहीं जाएगा।
- ड्राइवर को कॉल करना और हाल के ट्रिप इवेंट देखना।
- अंग्रेज़ी या हिंदी चुनना और नोटिफिकेशन की पसंद बदलना।

ड्राइवर कर सकते हैं:
- वैन, स्कूल, बच्चों, पिकअप पॉइंट और स्टॉप का क्रम सेट करना।
- सुबह या दोपहर की ट्रिप शुरू करना और हर स्टॉप का स्टेटस दर्ज करना।
- ट्रिप के दौरान जुड़े पैरेंट से वैन की लाइव लोकेशन साझा करना, फोन की स्क्रीन बंद होने पर भी।
- ट्रिप और फोन की स्थिति देखना, और आम Android फोन के बैटरी सेटिंग सुझाव पाना।
- वैन से जुड़े पैरेंट को इमरजेंसी अलर्ट भेजना।

ड्राइवर के ट्रिप शुरू करने पर लोकेशन शेयरिंग चालू होती है और ट्रिप खत्म होने पर रुकती है। लाइव अपडेट फोन के GPS, इंटरनेट और बैटरी सेटिंग पर निर्भर करते हैं। लोकेशन का इस्तेमाल विज्ञापन के लिए नहीं होता।

## Final console checklist

- App title/icon, screenshots in both languages, support contact, privacy-policy URL, account deletion URL, developer identity, and content rating.
- Target audience is adults (van drivers and parents); the app is not designed for children to use. Do not label it as a child-directed app without reassessing Google Play Families obligations.
- Background location permission declaration, foreground service location type declaration, and Android demonstration video.
- Data safety form for all app code, Firebase SDKs, Crashlytics, App Check, notification delivery, and the configured map provider.
- App access instructions and reviewer accounts for both roles; no real children's data in reviewer accounts or video.
- Data deletion URL works without installing the app, identifies the operator, and clearly exposes a deletion request path.
- Inspect the signed AAB's target API and merged manifest; test installation/update, foreground notification, permission denial, and trip end on Android 14+ and Android 16 devices.

## Official Google Play references

- [Background location permissions and declaration/video guidance](https://support.google.com/googleplay/android-developer/answer/9799150)
- [Foreground service and full-screen intent requirements](https://support.google.com/googleplay/android-developer/answer/13392821)
- [Data safety form definitions and rules](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Account deletion requirement](https://support.google.com/googleplay/android-developer/answer/13327111)
- [Target API level requirements](https://support.google.com/googleplay/android-developer/answer/11926878)
