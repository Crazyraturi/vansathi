import React from 'react';
import { Pressable, StyleSheet, Text, ViewStyle } from 'react-native';
import { colors, radius, spacing, type } from '../theme/tokens';
type Props = { label: string; onPress: () => void; variant?: 'primary' | 'secondary'; style?: ViewStyle; accessibilityLabel?: string; disabled?: boolean };
export function Button({ label, onPress, variant = 'primary', style, accessibilityLabel, disabled = false }: Props) {
  const primary = variant === 'primary';
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.base, primary ? styles.primary : styles.secondary, pressed && styles.pressed, disabled && styles.disabled, style]}><Text style={[styles.label, !primary && styles.secondaryLabel]}>{label}</Text></Pressable>;
}
const styles = StyleSheet.create({ base: { minHeight: 52, paddingHorizontal: spacing.lg, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill }, primary: { backgroundColor: colors.primary }, secondary: { backgroundColor: colors.pearl }, pressed: { opacity: 0.82 }, disabled: { opacity: 0.48 }, label: { color: colors.bodyOnDark, fontSize: type.button.size, fontWeight: '600' }, secondaryLabel: { color: colors.ink } });
