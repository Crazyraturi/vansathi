# Apple design reference adapted for VanSathi

Source: [Apple design analysis](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/apple/DESIGN.md). This file records the values needed by the first app milestone; tokens are centralized in `src/shared/theme/tokens.ts`.

## Visual direction

Near-invisible interface chrome, generous white and parchment surfaces, confident tight headlines, and a single Action Blue for interactive emphasis. For VanSathi, the memorable signature is a restrained route-line motif: two stop markers connected by one line. It communicates the school commute directly without using decorative gradients or generic map imagery.

## Tokens

- Colors: Action Blue `#0066CC`, focus blue `#0071E3`, on-dark blue `#2997FF`, ink `#1D1D1F`, white `#FFFFFF`, parchment `#F5F5F7`, pearl `#FAFAFC`, dark tile `#272729`, muted ink `#7A7A7A`, hairline `#E0E0E0`.
- Type: system UI/SF-compatible display and body faces; 40/28/21/17/14 px scale, 600-weight headlines, relaxed body line-height. System fallback preserves Devanagari shaping on Android.
- Spacing: 4, 8, 12, 17, 24, 32, 48, 80 px.
- Radii: 0, 5, 8, 11, 18 px, and pill. Full-width content panels can be square-edged; utility cards use 18 px; actions use pill shape.
- Surfaces: flat light and dark fields; no gradients or decorative shadows. Hairlines only for utility card boundaries.
- Interaction: minimum 44 pt action targets, clear pressed state, one blue primary action at a time.

## Mobile adaptation

The reference is a high-whitespace marketing site rather than a dense utility app. VanSathi preserves its colors, type voice, flat planes and single accent while tightening spacing for trip operations and maintaining large driver touch targets. Dark mode is not enabled because the supplied reference defines no app dark-mode system.
