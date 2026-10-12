import React from 'react';
import { Stack } from 'expo-router';
import '../src/shared/i18n';
import '../src/shared/trips/locationTask';
export default function RootLayout() { return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#F5F5F7' } }} />; }
