import React from 'react';
import { StyleSheet, View, ViewProps } from 'react-native';
import { colors, radius, spacing } from '../theme/tokens';
export function Card({ children, style, ...props }: ViewProps) { return <View {...props} style={[styles.card, style]}>{children}</View>; }
const styles = StyleSheet.create({ card: { backgroundColor: colors.canvas, borderColor: colors.hairline, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: spacing.lg } });
