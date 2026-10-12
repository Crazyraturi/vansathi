import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';
import { getAuth } from 'firebase-admin/auth';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { finishTrip as finishTripState, transitionStop, type StopStatus, type TripState, type TripType } from '../../src/shared/trips/stateMachine';
import { heartbeatIsExpired } from '../../src/shared/trips/heartbeat';
import { notifyParentsForTripEvent } from './notificationService';

if (getApps().length === 0) initializeApp();
setGlobalOptions({ region: 'asia-south1', maxInstances: 10 });

const db = getFirestore();
const rtdb = getDatabase();
const e164 = /^\+[1-9]\d{7,14}$/;
const languages = ['en', 'hi'] as const;
const privacyConsentVersion = '2026-10-11';
const roles = ['driver', 'parent'] as const;

type Role = typeof roles[number];
type Language = typeof languages[number];

function parseInput(value: unknown): { role: Role; language: Language; name: string } {
  if (!value || typeof value !== 'object') throw new HttpsError('invalid-argument', 'Check the details and try again.');
  const input = value as Record<string, unknown>;
  if (!roles.includes(input.role as Role) || !languages.includes(input.language as Language) ||
    typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.trim().length > 80) {
    throw new HttpsError('invalid-argument', 'Check the details and try again.');
  }
  return { role: input.role as Role, language: input.language as Language, name: input.name.trim() };
}

async function enforceRateLimit(uid: string): Promise<void> {
  const ref = db.collection('functionRateLimits').doc(uid);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const now = Date.now();
    const start = snapshot.get('windowStartedAt') as number | undefined;
    const count = snapshot.get('count') as number | undefined;
    const inWindow = typeof start === 'number' && now - start < 60_000;
    if (inWindow && (count ?? 0) >= 5) throw new HttpsError('resource-exhausted', 'Wait a minute and try again.');
    transaction.set(ref, { windowStartedAt: inWindow ? start : now, count: inWindow ? (count ?? 0) + 1 : 1 });
  });
}

async function syncParentAccess(uid: string, vanIds: string[]): Promise<void> {
  const mapping = Object.fromEntries(vanIds.map(vanId => [vanId, true]));
  await rtdb.ref(`access/parents/${uid}`).set(mapping);
}

async function attachPhoneMatches(uid: string, phone: string): Promise<number> {
  const matches = await db.collection('children').where('parentPhone', '==', phone).limit(400).get();
  const eligible = matches.docs.filter(child => !child.get('parentUid') || child.get('parentUid') === uid);
  const vanIds = [...new Set(eligible.map(child => child.get('vanId')).filter((id): id is string => typeof id === 'string'))];
  const batch = db.batch();
  for (const child of eligible) {
    if (child.get('parentUid') !== uid) batch.update(child.ref, { parentUid: uid });
  }
  batch.update(db.collection('users').doc(uid), { vanIds });
  await batch.commit();
  await syncParentAccess(uid, vanIds);
  return eligible.length;
}

export const finishOnboarding = onCall({ maxInstances: 5, enforceAppCheck: true }, async request => {
  const uid = request.auth?.uid;
  const phone = request.auth?.token.phone_number;
  if (!uid || typeof phone !== 'string' || !e164.test(phone)) {
    throw new HttpsError('unauthenticated', 'Sign in with a verified phone number to continue.');
  }
  await enforceRateLimit(uid);
  if (request.data?.privacyConsentVersion !== privacyConsentVersion) throw new HttpsError('failed-precondition', 'Review and accept the privacy notice to continue.');
  const { role, language, name } = parseInput(request.data);
  const userRef = db.collection('users').doc(uid);
  let driverVanId: string | undefined;

  await db.runTransaction(async transaction => {
    const user = await transaction.get(userRef);
    if (user.exists) {
      if (user.get('phone') !== phone || user.get('role') !== role) {
        throw new HttpsError('failed-precondition', 'This account is already set up with a different role.');
      }
      transaction.update(userRef, { name, language });
      return;
    }

    const profile = {
      role, phone, name, language, privacyConsentVersion, privacyConsentAt: FieldValue.serverTimestamp(), fcmTokens: [], vanIds: [], createdAt: FieldValue.serverTimestamp()
    };
    if (role === 'parent') {
      transaction.create(userRef, profile);
      return;
    }

    const approvalRef = db.collection('driverApprovals').doc(phone);
    const approval = await transaction.get(approvalRef);
    const vanId = approval.get('vanId');
    if (!approval.exists || approval.get('active') !== true || typeof vanId !== 'string' ||
      (approval.get('claimedUid') && approval.get('claimedUid') !== uid)) {
      throw new HttpsError('permission-denied', 'Ask your van owner to activate your driver account.');
    }
    const vanRef = db.collection('vans').doc(vanId);
    const van = await transaction.get(vanRef);
    if (!van.exists || (van.get('driverUid') && van.get('driverUid') !== uid)) {
      throw new HttpsError('permission-denied', 'This van is assigned to another driver.');
    }
    driverVanId = vanId;
    transaction.create(userRef, { ...profile, vanIds: [vanId] });
    transaction.update(approvalRef, { claimedUid: uid });
    transaction.update(vanRef, { driverUid: uid });
  });

  const user = await userRef.get();
  if (user.get('role') === 'parent') {
    const linkedChildren = await attachPhoneMatches(uid, phone);
    return { role, language, linkedChildren };
  }
  if (driverVanId) {
    await rtdb.ref(`access/drivers/${uid}/${driverVanId}`).set(true);
  } else {
    const vanIds = user.get('vanIds') as string[] | undefined;
    driverVanId = vanIds?.[0];
    if (driverVanId) await rtdb.ref(`access/drivers/${uid}/${driverVanId}`).set(true);
  }
  return { role, language, linkedChildren: 0, vanId: driverVanId };
});

export const recordPrivacyConsent = onCall({ maxInstances: 5, enforceAppCheck: true }, async request => {
  const uid = callableUid(request);
  if (request.data?.version !== privacyConsentVersion) throw new HttpsError('invalid-argument', 'The privacy notice version is not supported.');
  const userRef = db.collection('users').doc(uid);
  const user = await userRef.get();
  if (!user.exists) throw new HttpsError('failed-precondition', 'Finish account setup before saving consent.');
  await userRef.update({ privacyConsentVersion, privacyConsentAt: FieldValue.serverTimestamp() });
  return { accepted: true };
});

export const deleteAccountData = onCall({ maxInstances: 2, timeoutSeconds: 540, enforceAppCheck: true }, async request => {
  const uid = callableUid(request);
  await enforceRateLimit(uid);
  const userRef = db.collection('users').doc(uid);
  const user = await userRef.get();
  if (!user.exists) throw new HttpsError('not-found', 'Account data was not found.');
  const role = user.get('role');
  const phone = request.auth?.token.phone_number;
  if (role === 'parent') {
    while (true) {
      const children = await db.collection('children').where('parentUid', '==', uid).limit(400).get();
      if (children.empty) break;
      const batch = db.batch();
      children.docs.forEach(child => batch.update(child.ref, { parentUid: null, parentPhone: '' }));
      await batch.commit();
    }
    while (true) {
      const absences = await db.collection('absences').where('parentUid', '==', uid).limit(400).get();
      if (absences.empty) break;
      const batch = db.batch();
      absences.docs.forEach(absence => batch.delete(absence.ref));
      await batch.commit();
    }
    await userRef.delete();
    await rtdb.ref(`access/parents/${uid}`).remove();
  } else if (role === 'driver') {
    const vans = await db.collection('vans').where('driverUid', '==', uid).limit(20).get();
    const active = vans.docs.some(van => typeof van.get('activeTripId') === 'string');
    if (active) throw new HttpsError('failed-precondition', 'End the active trip before deleting this account.');
    for (const van of vans.docs) {
      while (true) {
        const trips = await db.collection('trips').where('vanId', '==', van.id).limit(200).get();
        if (trips.empty) break;
        for (const trip of trips.docs) {
          await db.recursiveDelete(trip.ref);
          await db.recursiveDelete(db.collection('tripPaths').doc(trip.id));
        }
      }
      while (true) {
        const children = await db.collection('children').where('vanId', '==', van.id).limit(400).get();
        if (children.empty) break;
        for (const child of children.docs) {
          while (true) {
            const absences = await db.collection('absences').where('childId', '==', child.id).limit(400).get();
            if (absences.empty) break;
            const batch = db.batch();
            absences.docs.forEach(absence => batch.delete(absence.ref));
            await batch.commit();
          }
        }
        const batch = db.batch();
        children.docs.forEach(child => batch.delete(child.ref));
        await batch.commit();
      }
      await van.ref.delete();
      await rtdb.ref(`live/${van.id}`).remove();
      await rtdb.ref(`access/activeTrips/${van.id}`).remove();
      await rtdb.ref(`access/drivers/${uid}/${van.id}`).remove();
    }
    if (typeof phone === 'string') await db.collection('driverApprovals').doc(phone).delete().catch(() => undefined);
    await userRef.delete();
  } else {
    await userRef.delete();
  }
  await db.collection('functionRateLimits').doc(uid).delete().catch(() => undefined);
  await getAuth().deleteUser(uid);
  return { deleted: true };
});

export const linkNewChildByPhone = onDocumentCreated('children/{childId}', async event => {
  const child = event.data?.data();
  if (!child || typeof child.parentPhone !== 'string' || !e164.test(child.parentPhone) || typeof child.vanId !== 'string') return;
  const parents = await db.collection('users').where('phone', '==', child.parentPhone).where('role', '==', 'parent').limit(1).get();
  const parent = parents.docs[0];
  if (!parent || (child.parentUid && child.parentUid !== parent.id)) return;
  if (!child.parentUid) await event.data?.ref.update({ parentUid: parent.id });
  const vanIds = [...new Set([...(parent.get('vanIds') as string[] ?? []), child.vanId])];
  await parent.ref.update({ vanIds });
  await syncParentAccess(parent.id, vanIds);
});

export const relinkEditedChildByPhone = onDocumentUpdated('children/{childId}', async event => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!before || !after || before.parentPhone === after.parentPhone || typeof after.parentPhone !== 'string' ||
    !e164.test(after.parentPhone) || typeof after.vanId !== 'string') return;

  const oldUid = typeof before.parentUid === 'string' ? before.parentUid : null;
  await event.data?.after.ref.update({ parentUid: null });
  if (oldUid) {
    const oldChildren = await db.collection('children').where('parentUid', '==', oldUid).get();
    const oldVanIds = [...new Set(oldChildren.docs.filter(child => child.id !== event.params.childId)
      .map(child => child.get('vanId')).filter((vanId): vanId is string => typeof vanId === 'string'))];
    await db.collection('users').doc(oldUid).update({ vanIds: oldVanIds });
    await syncParentAccess(oldUid, oldVanIds);
  }

  const parents = await db.collection('users').where('phone', '==', after.parentPhone).where('role', '==', 'parent').limit(1).get();
  const parent = parents.docs[0];
  if (!parent) return;
  await event.data?.after.ref.update({ parentUid: parent.id });
  const vanIds = [...new Set([...(parent.get('vanIds') as string[] ?? []), after.vanId])];
  await parent.ref.update({ vanIds });
  await syncParentAccess(parent.id, vanIds);
});

export const getParentVanContacts = onCall({ maxInstances: 5, enforceAppCheck: true }, async request => {
  const uid = callableUid(request);
  await enforceRateLimit(uid);
  const [userSnapshot, childSnapshot] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('children').where('parentUid', '==', uid).limit(400).get()
  ]);
  if (userSnapshot.get('role') !== 'parent') throw new HttpsError('permission-denied', 'Parent account required.');
  const vanIds = [...new Set(childSnapshot.docs.map(child => child.get('vanId')).filter((id): id is string => typeof id === 'string'))];
  const contacts = await Promise.all(vanIds.map(async vanId => {
    const van = await db.collection('vans').doc(vanId).get();
    const driverUid = van.get('driverUid');
    if (typeof driverUid !== 'string') return null;
    const driver = await db.collection('users').doc(driverUid).get();
    const name = driver.get('name');
    const phone = driver.get('phone');
    return typeof name === 'string' && typeof phone === 'string' && e164.test(phone) ? [vanId, { name, phone }] as const : null;
  }));
  return Object.fromEntries(contacts.filter((item): item is NonNullable<typeof item> => item !== null));
});

function callableUid(request: { auth?: { uid: string } }): string {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in before managing a trip.');
  return request.auth.uid;
}

function parseTripType(value: unknown): TripType {
  if (value !== 'morning' && value !== 'afternoon') throw new HttpsError('invalid-argument', 'Choose a valid trip type.');
  return value;
}

function todayInIndia(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function requireDriverVan(user: FirebaseFirestore.DocumentSnapshot, van: FirebaseFirestore.DocumentSnapshot, uid: string, vanId: string): void {
  const vanIds = user.get('vanIds') as string[] | undefined;
  if (user.get('role') !== 'driver' || !vanIds?.includes(vanId) || van.get('driverUid') !== uid) {
    throw new HttpsError('permission-denied', 'This driver is not assigned to that van.');
  }
}

export const startTrip = onCall({ maxInstances: 5, enforceAppCheck: true }, async request => {
  const uid = callableUid(request);
  const data = request.data as Record<string, unknown>;
  const vanId = data?.vanId;
  const tripType = parseTripType(data?.type);
  if (typeof vanId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(vanId)) {
    throw new HttpsError('invalid-argument', 'A valid van is required.');
  }
  const userRef = db.collection('users').doc(uid);
  const vanRef = db.collection('vans').doc(vanId);
  const tripRef = db.collection('trips').doc();
  const pathRef = db.collection('tripPaths').doc(tripRef.id);
  const startedAt = Date.now();
  const tripDate = todayInIndia();
  let returnedStops: { childId: string; name: string; status: StopStatus; location: { lat: number; lng: number } }[] = [];
  let schoolLocation: { lat: number; lng: number } | undefined;

  await db.runTransaction(async transaction => {
    const user = await transaction.get(userRef);
    const van = await transaction.get(vanRef);
    requireDriverVan(user, van, uid, vanId);
    const activeId = van.get('activeTripId');
    if (typeof activeId === 'string') {
      const active = await transaction.get(db.collection('trips').doc(activeId));
      if (active.exists && active.get('status') === 'started') {
        throw new HttpsError('failed-precondition', 'End the active trip before starting another.');
      }
    }
    const childQuery = db.collection('children').where('vanId', '==', vanId);
    const childSnapshot = await transaction.get(childQuery);
    const orderField = tripType === 'morning' ? 'morningOrder' : 'afternoonOrder';
    const sorted = childSnapshot.docs.sort((a, b) => (a.get(orderField) as number) - (b.get(orderField) as number));
    if (sorted.length === 0) throw new HttpsError('failed-precondition', 'Add at least one child before starting a trip.');
    if (typeof van.get('seats') === 'number' && sorted.length > van.get('seats')) {
      throw new HttpsError('failed-precondition', 'The child list exceeds the van seat count.');
    }
    const absenceRefs = sorted.map(child => db.collection('absences').doc(`${tripDate}_${tripType}_${child.id}`));
    const absenceSnapshots = await Promise.all(absenceRefs.map(reference => transaction.get(reference)));
    returnedStops = sorted.map((child, index) => {
      const absence = absenceSnapshots[index];
      const isAbsent = absence.exists && absence.get('parentUid') === child.get('parentUid') && absence.get('childId') === child.id &&
        absence.get('tripType') === tripType && absence.get('date') === tripDate && absence.get('cancelled') !== true;
      const pin = child.get('homeLocation') as { lat: number; lng: number };
      return { childId: child.id, name: child.get('name') as string, status: isAbsent ? 'absent' : 'pending', location: { lat: pin.lat, lng: pin.lng } };
    });
    const school = van.get('school') as { lat: number; lng: number };
    schoolLocation = { lat: school.lat, lng: school.lng };
    const storedStops = returnedStops.map(({ location: _location, ...stop }) => stop);
    const trip: TripState & { startedAt: FirebaseFirestore.Timestamp } = {
      id: tripRef.id, vanId, type: tripType, status: 'started',
      startedAt: Timestamp.fromMillis(startedAt), endedAt: null, stops: storedStops
    } as TripState & { startedAt: FirebaseFirestore.Timestamp };
    transaction.create(tripRef, trip);
    transaction.update(vanRef, { activeTripId: tripRef.id, activeTripType: tripType });
    transaction.create(pathRef, { vanId, type: tripType, status: 'started', startedAt: Timestamp.fromMillis(startedAt), endedAt: null });
  });
  try {
    await rtdb.ref(`access/activeTrips/${vanId}`).set(true);
  } catch {
    const endedAt = Timestamp.now();
    await db.runTransaction(async transaction => {
      const trip = await transaction.get(tripRef);
      const van = await transaction.get(vanRef);
      if (trip.exists && trip.get('status') === 'started') {
        transaction.update(tripRef, { status: 'cancelled', endedAt });
        if (van.get('activeTripId') === tripRef.id) transaction.update(vanRef, { activeTripId: null, activeTripType: null });
      }
    });
    await pathRef.update({ status: 'cancelled', endedAt });
    throw new HttpsError('unavailable', 'Could not start live location sharing. Try again.');
  }
  await tripRef.collection('events').doc('trip_started').set({ type: 'trip_started', tripType, createdAt: FieldValue.serverTimestamp(), occurredAt: Timestamp.fromMillis(startedAt) }).catch(() => undefined);
  return { tripId: tripRef.id, vanId, type: tripType, startedAt, stops: returnedStops, schoolLocation };
});

export const recordStopAction = onCall({ maxInstances: 5, enforceAppCheck: true }, async request => {
  const uid = callableUid(request);
  const data = request.data as Record<string, unknown>;
  const tripId = data?.tripId;
  const childId = data?.childId;
  const status = data?.status;
  const eventId = data?.eventId;
  const occurredAt = data?.occurredAt;
  if (typeof tripId !== 'string' || typeof childId !== 'string' || typeof status !== 'string' ||
    !['arrived', 'picked_up', 'dropped', 'skipped', 'absent'].includes(status) ||
    typeof eventId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId) ||
    typeof occurredAt !== 'number' || !Number.isSafeInteger(occurredAt) || occurredAt < 0 || occurredAt > 253402300799999) {
    throw new HttpsError('invalid-argument', 'Check the stop update and try again.');
  }
  const tripRef = db.collection('trips').doc(tripId);
  const eventRef = tripRef.collection('events').doc(eventId);
  await db.runTransaction(async transaction => {
    const existingEvent = await transaction.get(eventRef);
    if (existingEvent.exists) return;
    const tripSnapshot = await transaction.get(tripRef);
    if (!tripSnapshot.exists) throw new HttpsError('not-found', 'This trip is no longer available.');
    const vanRef = db.collection('vans').doc(tripSnapshot.get('vanId') as string);
    const userRef = db.collection('users').doc(uid);
    const van = await transaction.get(vanRef);
    const user = await transaction.get(userRef);
    requireDriverVan(user, van, uid, tripSnapshot.get('vanId') as string);
    const tripData = tripSnapshot.data()!;
    if (tripData.status !== 'started') throw new HttpsError('failed-precondition', 'This trip has ended.');
    const tripState: TripState = {
      id: tripSnapshot.id,
      vanId: tripData.vanId as string,
      type: tripData.type as TripType,
      status: tripData.status,
      startedAt: tripData.startedAt instanceof Timestamp ? tripData.startedAt.toMillis() : tripData.startedAt as number,
      endedAt: null,
      stops: tripData.stops as TripState['stops']
    };
    let next: TripState;
    try { next = transitionStop(tripState, childId, status as StopStatus); }
    catch { throw new HttpsError('failed-precondition', 'That stop update is not allowed.'); }
    transaction.update(tripRef, { stops: next.stops });
    transaction.create(eventRef, {
      type: 'stop_status', childId, status,
      occurredAt: Timestamp.fromMillis(occurredAt > Date.now() + 60_000 ? Date.now() : occurredAt),
      driverUid: uid, createdAt: FieldValue.serverTimestamp(), idempotencyKey: eventId
    });
  });
  return { accepted: true };
});

export const recordTripEvent = onCall({ maxInstances: 5, enforceAppCheck: true }, async request => {
  const uid = callableUid(request);
  const data = request.data as Record<string, unknown>;
  const { tripId, eventId, eventType, childId, distanceMeters, etaMinutes, occurredAt } = data;
  if (typeof tripId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(tripId) || typeof eventId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId) ||
    (eventType !== 'van_near' && eventType !== 'reached_school') || typeof occurredAt !== 'number' ||
    !Number.isSafeInteger(occurredAt) || occurredAt < 0 || occurredAt > Date.now() + 60_000 ||
    typeof distanceMeters !== 'number' || !Number.isFinite(distanceMeters) || distanceMeters < 0 || distanceMeters > 5_000 ||
    (eventType === 'van_near' && (typeof childId !== 'string' || !Number.isInteger(etaMinutes) || (etaMinutes as number) < 0 || (etaMinutes as number) > 2_000))) {
    throw new HttpsError('invalid-argument', 'Check the trip event and try again.');
  }
  if ((eventType === 'van_near' && eventId !== `van_near_${String(childId)}`) || (eventType === 'reached_school' && eventId !== 'reached_school')) {
    throw new HttpsError('invalid-argument', 'This event has an invalid id.');
  }
  const tripRef = db.collection('trips').doc(tripId);
  const eventRef = tripRef.collection('events').doc(eventId);
  await db.runTransaction(async transaction => {
    const [event, trip] = await Promise.all([transaction.get(eventRef), transaction.get(tripRef)]);
    if (event.exists) return;
    if (!trip.exists || trip.get('status') !== 'started') throw new HttpsError('failed-precondition', 'This trip has ended.');
    const vanId = trip.get('vanId') as string;
    const vanRef = db.collection('vans').doc(vanId);
    const userRef = db.collection('users').doc(uid);
    const [van, user] = await Promise.all([transaction.get(vanRef), transaction.get(userRef)]);
    requireDriverVan(user, van, uid, vanId);
    if (van.get('activeTripId') !== tripId) throw new HttpsError('failed-precondition', 'This is not the active trip.');
    if (eventType === 'van_near') {
      const stopExists = (trip.get('stops') as TripState['stops']).some(stop => stop.childId === childId);
      if (!stopExists) throw new HttpsError('permission-denied', 'This stop is not part of the trip.');
    } else if (trip.get('type') !== 'morning') {
      throw new HttpsError('failed-precondition', 'School arrival only applies to the morning trip.');
    }
    transaction.create(eventRef, {
      type: eventType, childId: eventType === 'van_near' ? childId : null,
      distanceMeters: Math.round(distanceMeters), ...(eventType === 'van_near' ? { etaMinutes } : {}),
      occurredAt: Timestamp.fromMillis(Math.min(occurredAt, Date.now())), driverUid: uid, idempotencyKey: eventId
    });
  });
  return { accepted: true };
});

export const sendEmergencyAlert = onCall({ maxInstances: 5, enforceAppCheck: true }, async request => {
  const uid = callableUid(request);
  await enforceRateLimit(uid);
  const data = request.data as Record<string, unknown>;
  const tripId = data?.tripId;
  const eventId = data?.eventId;
  if (typeof tripId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(tripId) || typeof eventId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId)) {
    throw new HttpsError('invalid-argument', 'Could not send the emergency alert.');
  }
  const tripRef = db.collection('trips').doc(tripId);
  const eventRef = tripRef.collection('events').doc(`emergency_${eventId}`);
  await db.runTransaction(async transaction => {
    const [trip, existing] = await Promise.all([transaction.get(tripRef), transaction.get(eventRef)]);
    if (existing.exists) return;
    if (!trip.exists || trip.get('status') !== 'started') throw new HttpsError('failed-precondition', 'This trip has ended.');
    const vanId = trip.get('vanId') as string;
    const vanRef = db.collection('vans').doc(vanId);
    const userRef = db.collection('users').doc(uid);
    const [van, user] = await Promise.all([transaction.get(vanRef), transaction.get(userRef)]);
    requireDriverVan(user, van, uid, vanId);
    if (van.get('activeTripId') !== tripId) throw new HttpsError('failed-precondition', 'This is not the active trip.');
    transaction.create(eventRef, { type: 'emergency', driverUid: uid, createdAt: FieldValue.serverTimestamp(), occurredAt: Timestamp.now(), idempotencyKey: eventId });
  });
  return { accepted: true };
});

export const endTrip = onCall({ maxInstances: 5, enforceAppCheck: true }, async request => {
  const uid = callableUid(request);
  const data = request.data as Record<string, unknown>;
  const tripId = data?.tripId;
  const cancelled = data?.cancelled === true;
  const endedAtMs = data?.endedAt;
  if (typeof tripId !== 'string' || typeof endedAtMs !== 'number' || !Number.isSafeInteger(endedAtMs) || endedAtMs > Date.now() + 60_000) {
    throw new HttpsError('invalid-argument', 'A valid trip end time is required.');
  }
  const tripRef = db.collection('trips').doc(tripId);
  let vanId = '';
  let endedAt: Timestamp | null = null;
  await db.runTransaction(async transaction => {
    const tripSnapshot = await transaction.get(tripRef);
    if (!tripSnapshot.exists) throw new HttpsError('not-found', 'This trip is no longer available.');
    vanId = tripSnapshot.get('vanId') as string;
    const vanRef = db.collection('vans').doc(vanId);
    const userRef = db.collection('users').doc(uid);
    const van = await transaction.get(vanRef);
    const user = await transaction.get(userRef);
    requireDriverVan(user, van, uid, vanId);
    const status = tripSnapshot.get('status');
    if (status === (cancelled ? 'cancelled' : 'completed')) return;
    if (status !== 'started') throw new HttpsError('failed-precondition', 'This trip has already ended.');
    const started = tripSnapshot.get('startedAt');
    const startedAt = started instanceof Timestamp ? started.toMillis() : Number(started);
    const state: TripState = {
      id: tripSnapshot.id, vanId, type: tripSnapshot.get('type') as TripType, status: 'started',
      startedAt, endedAt: null, stops: tripSnapshot.get('stops') as TripState['stops']
    };
    let finished: TripState;
    try { finished = finishTripState(state, endedAtMs, cancelled); }
    catch { throw new HttpsError('failed-precondition', 'The trip end time is invalid.'); }
    endedAt = Timestamp.fromMillis(finished.endedAt!);
    transaction.update(tripRef, { status: finished.status, endedAt });
    transaction.update(vanRef, { activeTripId: null, activeTripType: null });
    if (!cancelled && state.type === 'morning') {
      for (const stop of state.stops.filter(item => item.status === 'pending' || item.status === 'arrived')) {
        transaction.create(tripRef.collection('events').doc(`not_picked_up_${stop.childId}`), {
          type: 'not_picked_up', childId: stop.childId, createdAt: FieldValue.serverTimestamp(), occurredAt: endedAt
        });
      }
    }
  });
  if (endedAt) await db.collection('tripPaths').doc(tripId).update({ status: cancelled ? 'cancelled' : 'completed', endedAt });
  await rtdb.ref(`access/activeTrips/${vanId}`).set(false);
  await rtdb.ref(`live/${vanId}`).update({ tripActive: false });
  return { accepted: true };
});

export const notifyTripEvent = onDocumentCreated({ document: 'trips/{tripId}/events/{eventId}', retry: true }, async event => {
  await notifyParentsForTripEvent(event.params.tripId, event.params.eventId);
});

export const markAbandonedTrips = onSchedule({ schedule: 'every 5 minutes', timeZone: 'Asia/Kolkata' }, async () => {
  const activeTrips = await db.collection('trips').where('status', '==', 'started').limit(500).get();
  const now = Date.now();
  for (const candidate of activeTrips.docs) {
    const vanId = candidate.get('vanId');
    if (typeof vanId !== 'string') continue;
    const live = (await rtdb.ref(`live/${vanId}`).get()).val() as { timestamp?: number } | null;
    const started = candidate.get('startedAt');
    const startedAt = started instanceof Timestamp ? started.toMillis() : Number(started);
    const heartbeatAt = typeof live?.timestamp === 'number' ? live.timestamp : null;
    if (!heartbeatIsExpired(now, heartbeatAt, startedAt)) continue;

    const tripRef = candidate.ref;
    const vanRef = db.collection('vans').doc(vanId);
    const pathRef = db.collection('tripPaths').doc(candidate.id);
    const lostEventRef = tripRef.collection('events').doc('location_lost');
    const abandonedAt = Timestamp.fromMillis(now);
    const releasedActivePointer = await db.runTransaction(async transaction => {
      const [trip, van, lostEvent] = await Promise.all([transaction.get(tripRef), transaction.get(vanRef), transaction.get(lostEventRef)]);
      if (!trip.exists || trip.get('status') !== 'started') return false;
      transaction.update(tripRef, { status: 'abandoned', endedAt: abandonedAt, abandonedAt });
      transaction.update(pathRef, { status: 'abandoned', endedAt: abandonedAt });
      if (!lostEvent.exists) transaction.create(lostEventRef, { type: 'location_lost', createdAt: FieldValue.serverTimestamp(), occurredAt: abandonedAt });
      if (van.get('activeTripId') === tripRef.id) {
        transaction.update(vanRef, { activeTripId: null, activeTripType: null });
        return true;
      }
      return false;
    });
    if (releasedActivePointer) {
      await rtdb.ref(`access/activeTrips/${vanId}`).set(false);
      await rtdb.ref(`live/${vanId}`).update({ tripActive: false });
    }
  }
});

export const deleteExpiredTripPoints = onSchedule({ schedule: '0 3 * * *', timeZone: 'Asia/Kolkata' }, async () => {
  const cutoff = Date.now() - 30 * 24 * 60 * 60_000;
  for (let batchNumber = 0; batchNumber < 25; batchNumber += 1) {
    const expired = await db.collectionGroup('points').where('timestamp', '<', cutoff).orderBy('timestamp').limit(400).get();
    if (expired.empty) return;
    const batch = db.batch();
    expired.docs.forEach(point => batch.delete(point.ref));
    await batch.commit();
    if (expired.size < 400) return;
  }
});
