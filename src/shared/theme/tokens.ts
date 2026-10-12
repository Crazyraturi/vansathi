export const colors = {
  primary: '#0066CC', primaryFocus: '#0071E3', primaryOnDark: '#2997FF',
  ink: '#1D1D1F', body: '#1D1D1F', bodyOnDark: '#FFFFFF', bodyMuted: '#CCCCCC',
  mutedInk: '#7A7A7A', canvas: '#FFFFFF', parchment: '#F5F5F7', pearl: '#FAFAFC',
  tile: '#272729', tileAlt: '#2A2A2C', tileDark: '#252527', divider: '#F0F0F0', hairline: '#E0E0E0',
  success: '#248A3D', warning: '#9A6700', danger: '#D70015'
} as const;
export const spacing = { xxs: 4, xs: 8, sm: 12, md: 17, lg: 24, xl: 32, xxl: 48, section: 80 } as const;
export const radius = { none: 0, xs: 5, sm: 8, md: 11, lg: 18, pill: 9999, full: 9999 } as const;
export const type = {
  hero: { size: 40, weight: '600' as const, lineHeight: 44, tracking: -0.28 },
  title: { size: 28, weight: '600' as const, lineHeight: 34, tracking: -0.25 },
  tagline: { size: 21, weight: '600' as const, lineHeight: 25, tracking: 0.23 },
  bodyStrong: { size: 17, weight: '600' as const, lineHeight: 22, tracking: -0.37 },
  body: { size: 17, weight: '400' as const, lineHeight: 25, tracking: -0.25 },
  caption: { size: 14, weight: '400' as const, lineHeight: 20, tracking: -0.22 },
  button: { size: 18, weight: '600' as const, lineHeight: 22, tracking: 0 }
} as const;
export const fonts = { display: 'system-ui', body: 'system-ui', devanagari: 'sans-serif' } as const;
