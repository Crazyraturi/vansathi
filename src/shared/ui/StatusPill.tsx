import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../theme/tokens';
export function StatusPill({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'good' | 'warning' | 'danger' }) {
  const color = tone === 'good' ? colors.success : tone === 'warning' ? colors.warning : tone === 'danger' ? colors.danger : colors.mutedInk;
  return <View style={[styles.pill, { backgroundColor: `${color}14` }]}><View style={[styles.dot, { backgroundColor: color }]} /><Text style={[styles.label, { color }]}>{label}</Text></View>;
}
const styles = StyleSheet.create({ pill: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: spacing.xs, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs }, dot: { width: 7, height: 7, borderRadius: radius.full }, label: { fontSize: 14, fontWeight: '600' } });
