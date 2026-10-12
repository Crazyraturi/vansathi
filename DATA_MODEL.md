# Data model and access boundaries

All client reads and writes are checked by database rules. Cloud Functions use the Admin SDK from authenticated, validated requests or Firestore triggers. Driver approvals, function rate limits, and Realtime Database access indexes are server-managed.

## Firestore

- `users/{uid}`: `role` (`driver` or `parent`), `name`, verified `phone` (E.164), `language` (`en` or `hi`), `privacyConsentVersion`, `privacyConsentAt`, `fcmTokens[]`, optional `notificationPreferences{tripUpdates,locationWarnings,emergencyAlerts}`, `vanIds[]`, `createdAt`. Created by `finishOnboarding`; clients may update only name, language, FCM tokens, and the bounded preference map. Role, phone, consent record, linked vans, and creation time are server-managed.
- `driverApprovals/{phone}`: Console-managed `active`, `vanId`, and `claimedUid`. A driver role is issued only when the authenticated phone matches an active approval. Client access is denied.
- `vans/{vanId}`: `driverUid`, `number`, `name`, `seats`, `school{name,lat,lng}`, `emergencyPhone`. Reads are limited to the assigned driver and linked parents. The assigned driver may update only these setup fields; assignment remains server-managed.
- `children/{childId}`: `vanId`, `name`, `class`, `parentPhone`, `parentUid`, `homeLocation{lat,lng}`, `morningOrder`, `afternoonOrder`. The assigned driver manages child records and stop order. Create and update rules validate E.164 phone numbers, coordinates, and bounded integer order values. Server triggers link a matching parent and refresh the link when the phone number is edited.
- `trips/{tripId}`: `vanId`, `type`, `status`, `startedAt`, `endedAt`, `stops[]`; event documents are at `trips/{tripId}/events/{eventId}`. Callable functions alone create trips, enforce stop state transitions, and end trips. Parents read linked-van trips only while active or for 30 days after ending.
- `tripPaths/{tripId}`: server-managed trip and van metadata; sampled `points/{bucketId}` documents contain only `lat`, `lng`, `accuracy`, and `timestamp`. Assigned drivers write points only while a trip is active; linked parents may read an active or recent path.
- `absences/{date_tripType_childId}`: `parentUid`, `childId`, `date`, and `tripType`. A parent may manage only an absence for their linked child and can remove a request before the driver starts.
- `driverApprovals` and `functionRateLimits` are never readable or writable by clients.

## Realtime Database

- `live/{vanId}` contains the latest position only: `lat`, `lng`, `speed`, `heading`, `accuracy`, `timestamp`, `tripId`, `batteryLevel`, `tripActive`. Only the assigned driver may write. A linked parent may read only while `tripActive` is true.
- `access/drivers/{uid}/{vanId}`, `access/parents/{uid}/{vanId}`, and `access/activeTrips/{vanId}` are server-maintained authorization indexes. Clients cannot read or write them. The active-trip flag gates driver writes as well as parent reads, so a late background callback cannot revive a location after the server ends a trip. Functions maintain these indexes because Realtime Database rules cannot query Firestore.

## Trusted linking flow

The phone is taken from the verified Firebase Auth token, never from callable input. `finishOnboarding` creates the profile; for a parent it attaches only unclaimed child records whose `parentPhone` exactly matches the verified E.164 number. `linkNewChildByPhone` handles children added later and `relinkEditedChildByPhone` refreshes access when a driver changes the parent number. These functions update the server-managed van access index used by live-location rules. `getParentVanContacts` returns driver call details only for vans connected to the authenticated parent's linked children.

Firestore composite indexes are declared in `firestore.indexes.json`: parent trip queries by van and status/end time, plus today's absences by parent and date.

Trip writes are server-owned: `startTrip` atomically claims `vans/{vanId}.activeTripId` and creates the trip/path documents; it checks same-day India-local absence requests and pre-marks matching stops absent. `recordStopAction` applies the shared pure state machine and an idempotent event; `recordTripEvent` accepts deterministic proximity hints; `endTrip` closes the trip, releases the van, and disables parent live reads. Event notification receipts are stored under each trip event to deduplicate trigger retries. A five-minute scheduled function abandons trips without a heartbeat for 30 minutes, and a daily function deletes breadcrumb points older than 30 days. The client stores route coordinates and active state in SQLCipher and a maximum of 500 queued event/breadcrumb/end operations; its key and active-trip pointer are stored with SecureStore.

`recordPrivacyConsent` stores the current English/Hindi notice version and server timestamp. `deleteAccountData` removes parent absences and unlinks children while clearing the parent's contact number, or (after the driver's active trip has ended) recursively removes the driver's van, children, trips/events, trip paths, approval record, and matching RTDB indexes before deleting the Firebase Auth account.
