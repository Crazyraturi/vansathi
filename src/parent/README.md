# Parent role

Parent workflows live here and remain independent from driver setup/tracking screens. `ParentHome` shows only linked children, subscribes to live location only for active trips, and displays an explicit stale warning after 60 seconds. It also provides driver call, absence request, recent trip history, and English/Hindi settings.

Driver contact details are fetched through the authenticated `getParentVanContacts` callable, which checks the caller's role and linked children before returning phone numbers. Map tiles require `EXPO_PUBLIC_MAP_STYLE_URL`. ETA is a rough estimate based on the current speed with a conservative minimum-speed floor; it is not a traffic-aware arrival promise.
