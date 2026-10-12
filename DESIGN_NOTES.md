# Design notes

- The supplied Apple design analysis specifies web-oriented SF Pro typography and spacious product tiles. The mobile UI uses the native platform system font stack so iOS resolves SF Pro and Android uses a local system sans face with Devanagari support. Exact font parity cannot be promised cross-platform without shipping licensed/properly bundled font assets.
- The design reference contains no status colors or map component. Status tones use platform-familiar green/amber/red and the map marker remains a future component; these extensions need visual review when those screens are implemented.
- The starter component set includes Button, Card, StatusPill, and EmptyState. ListRow, MapMarker, Sheet, Toast, and ErrorState are deferred until screens need their behavior.
- Role choice is persisted by the server after OTP authentication; a versioned privacy notice is shown before role setup and uses the established card, type and spacing tokens.
- The consent notice and OEM battery help extend the existing typography and neutral/surface tokens; the Apple reference does not define legal copy or device-specific settings illustrations. The privacy text is plain and bilingual, and the OEM directions are text-only because manufacturer menus differ by firmware.
