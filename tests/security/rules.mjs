import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { ref, get, set } from 'firebase/database';

const projectId = 'demo-vansathi';
let env;

const livePosition = active => ({ lat: 12.9716, lng: 77.5946, speed: 2, heading: 90, accuracy: 8, timestamp: Date.now(), tripId: 'trip-a', batteryLevel: 74, tripActive: active });

before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
    database: { rules: readFileSync(new URL('../../database.rules.json', import.meta.url), 'utf8'), host: '127.0.0.1', port: 9000 }
  });
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await Promise.all([
      setDoc(doc(db, 'users/parent-a'), { role: 'parent', phone: '+919876543210', name: 'Parent', language: 'en', fcmTokens: [], vanIds: ['van-a'], createdAt: new Date() }),
      setDoc(doc(db, 'users/parent-b'), { role: 'parent', phone: '+919876543211', name: 'Parent B', language: 'en', fcmTokens: [], vanIds: ['van-b'], createdAt: new Date() }),
      setDoc(doc(db, 'users/driver-a'), { role: 'driver', phone: '+919876543212', name: 'Driver', language: 'en', fcmTokens: [], vanIds: ['van-a'], createdAt: new Date() }),
      setDoc(doc(db, 'vans/van-a'), { driverUid: 'driver-a', number: 'KA-01-AB-1234' }),
      setDoc(doc(db, 'vans/van-b'), { driverUid: 'driver-b', number: 'KA-02-CD-4567' }),
      setDoc(doc(db, 'children/child-a'), { vanId: 'van-a', name: 'Child A', parentPhone: '+919876543210', parentUid: 'parent-a' }),
      setDoc(doc(db, 'children/child-b'), { vanId: 'van-b', name: 'Child B', parentPhone: '+919876543211', parentUid: 'parent-b' }),
      setDoc(doc(db, 'trips/trip-a'), { vanId: 'van-a', type: 'morning', status: 'started', startedAt: new Date(), endedAt: null, stops: [] }),
      setDoc(doc(db, 'tripPaths/trip-a'), { vanId: 'van-a', type: 'morning', status: 'started', startedAt: new Date(), endedAt: null })
    ]);
  });
  await env.withSecurityRulesDisabled(async context => {
    const db = context.database();
    await set(ref(db), null);
    await set(ref(db, 'access/parents/parent-a/van-a'), true);
    await set(ref(db, 'access/drivers/driver-a/van-a'), true);
    await set(ref(db, 'access/activeTrips/van-a'), true);
    await set(ref(db, 'live/van-a'), livePosition(true));
    await set(ref(db, 'live/van-b'), livePosition(false));
  });
});

after(async () => { await env?.cleanup(); });

describe('Firestore rules', () => {
  it('allows a linked parent to read the linked van and denies another van', async () => {
    const db = env.authenticatedContext('parent-a').firestore();
    await assertSucceeds(getDoc(doc(db, 'vans/van-a')));
    await assertFails(getDoc(doc(db, 'vans/van-b')));
  });

  it('denies a driver access to a different van', async () => {
    const db = env.authenticatedContext('driver-a').firestore();
    await assertFails(getDoc(doc(db, 'vans/van-b')));
  });

  it('limits each parent to their own linked children', async () => {
    const db = env.authenticatedContext('parent-a').firestore();
    await assertSucceeds(getDoc(doc(db, 'children/child-a')));
    await assertFails(getDoc(doc(db, 'children/child-b')));
  });

  it('does not let a client change its immutable role', async () => {
    const db = env.authenticatedContext('parent-a').firestore();
    await assertFails(updateDoc(doc(db, 'users/parent-a'), { role: 'driver' }));
  });

  it('lets a parent save only the supported notification preferences', async () => {
    const db = env.authenticatedContext('parent-a').firestore();
    await assertSucceeds(updateDoc(doc(db, 'users/parent-a'), {
      notificationPreferences: { tripUpdates: true, locationWarnings: false, emergencyAlerts: true }
    }));
    await assertFails(updateDoc(doc(db, 'users/parent-a'), {
      notificationPreferences: { tripUpdates: true, locationWarnings: false, emergencyAlerts: true, marketing: true }
    }));
  });

  it('does not let clients create or modify driver approval records', async () => {
    const db = env.authenticatedContext('parent-a').firestore();
    await assertFails(setDoc(doc(db, 'driverApprovals/+919876543210'), { active: true, vanId: 'van-a' }));
  });

  it('lets the assigned driver update van setup fields but not driver ownership', async () => {
    const db = env.authenticatedContext('driver-a').firestore();
    await assertSucceeds(updateDoc(doc(db, 'vans/van-a'), {
      number: 'KA-01-AB-1234', name: 'School Van', seats: 12,
      school: { name: 'Primary School', lat: 12.97, lng: 77.59 }, emergencyPhone: '+919876543210'
    }));
    await assertFails(updateDoc(doc(db, 'vans/van-a'), { driverUid: 'driver-b' }));
  });

  it('rejects invalid school pins and child stop locations', async () => {
    const db = env.authenticatedContext('driver-a').firestore();
    await assertFails(updateDoc(doc(db, 'vans/van-a'), {
      number: 'KA-01-AB-1234', name: 'School Van', seats: 12,
      school: { name: 'Primary School', lat: 91, lng: 77.59 }, emergencyPhone: ''
    }));
    await assertFails(setDoc(doc(db, 'children/new-child'), {
      vanId: 'van-a', name: 'Child', class: '4', parentPhone: '+919876543210', parentUid: null,
      homeLocation: { lat: 12.97, lng: 181 }, morningOrder: 0, afternoonOrder: 0
    }));
  });

  it('allows the assigned driver to add a child with bounded locations and stop order', async () => {
    const db = env.authenticatedContext('driver-a').firestore();
    await assertSucceeds(setDoc(doc(db, 'children/new-child'), {
      vanId: 'van-a', name: 'Child', class: '4', parentPhone: '+919876543210', parentUid: null,
      homeLocation: { lat: 12.97, lng: 77.59 }, morningOrder: 0, afternoonOrder: 0
    }));
    await assertSucceeds(updateDoc(doc(db, 'children/new-child'), { parentPhone: '' }));
    await assertSucceeds(updateDoc(doc(db, 'children/new-child'), { name: 'Child Updated' }));
  });

  it('does not let a parent edit a linked child record', async () => {
    const db = env.authenticatedContext('parent-a').firestore();
    await assertFails(updateDoc(doc(db, 'children/child-a'), { name: 'Changed' }));
  });

  it('does not let a driver bypass the server trip state machine', async () => {
    const db = env.authenticatedContext('driver-a').firestore();
    await assertFails(setDoc(doc(db, 'trips/trip-b'), { vanId: 'van-a', type: 'morning', status: 'started' }));
    await assertFails(updateDoc(doc(db, 'trips/trip-a'), { status: 'completed' }));
  });

  it('allows linked parents to read active trip breadcrumbs', async () => {
    const db = env.authenticatedContext('parent-a').firestore();
    await env.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'tripPaths/trip-a/points/point-a'), { lat: 12.97, lng: 77.59, accuracy: 9, timestamp: Date.now() });
    });
    await assertSucceeds(getDoc(doc(db, 'tripPaths/trip-a/points/point-a')));
  });

  it('limits breadcrumb writes to the assigned driver and valid point fields', async () => {
    const driverDb = env.authenticatedContext('driver-a').firestore();
    const parentDb = env.authenticatedContext('parent-a').firestore();
    const validPoint = { lat: 12.97, lng: 77.59, accuracy: 9, timestamp: Date.now() };
    await assertSucceeds(setDoc(doc(driverDb, 'tripPaths/trip-a/points/point-a'), validPoint));
    await assertFails(setDoc(doc(driverDb, 'tripPaths/trip-a/points/point-b'), { ...validPoint, lat: 91 }));
    await assertFails(setDoc(doc(parentDb, 'tripPaths/trip-a/points/point-c'), validPoint));
  });
});

describe('Realtime Database rules', () => {
  it('allows a linked parent to read only an active van location', async () => {
    const db = env.authenticatedContext('parent-a').database();
    await assertSucceeds(get(ref(db, 'live/van-a')));
    await assertFails(get(ref(db, 'live/van-b')));
  });

  it('denies all location reads for an inactive trip', async () => {
    await env.withSecurityRulesDisabled(async context => {
      await set(ref(context.database(), 'access/parents/parent-a/van-b'), true);
    });
    const db = env.authenticatedContext('parent-a').database();
    await assertFails(get(ref(db, 'live/van-b')));
  });

  it('denies a parent from writing a location', async () => {
    const db = env.authenticatedContext('parent-a').database();
    await assertFails(set(ref(db, 'live/van-a'), livePosition(true)));
  });

  it('allows the assigned driver to update its van location', async () => {
    const db = env.authenticatedContext('driver-a').database();
    await assertSucceeds(set(ref(db, 'live/van-a'), livePosition(true)));
  });

  it('does not let a client change the server-managed active-trip access marker', async () => {
    const db = env.authenticatedContext('driver-a').database();
    await assertFails(set(ref(db, 'access/activeTrips/van-a'), false));
  });

  it('rejects invalid coordinates even from the assigned driver', async () => {
    const db = env.authenticatedContext('driver-a').database();
    await assertFails(set(ref(db, 'live/van-a'), { ...livePosition(true), lat: 91 }));
  });
});
