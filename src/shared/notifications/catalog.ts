import en from '../../../locales/en.json';
import hi from '../../../locales/hi.json';

export type PushCopyKind = 'trip_started' | 'van_near' | 'picked_up' | 'absent' | 'dropped' | 'reached_school' | 'not_picked_up' | 'emergency' | 'location_lost';
type Language = 'en' | 'hi';
type Variables = Record<string, string | number>;
const catalogs: Record<Language, Record<string, string>> = { en, hi };

function interpolate(template: string, variables: Variables): string {
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, key: string) => String(variables[key] ?? ''));
}

export function getPushCopy(language: Language, kind: PushCopyKind, variables: Variables): { title: string; body: string } {
  const catalog = catalogs[language] ?? catalogs.en;
  return {
    title: interpolate(catalog[`push_${kind}_title`] ?? catalogs.en[`push_${kind}_title`], variables),
    body: interpolate(catalog[`push_${kind}_body`] ?? catalogs.en[`push_${kind}_body`], variables)
  };
}

export function getPushText(language: Language, key: string, variables: Variables = {}): string {
  const catalog = catalogs[language] ?? catalogs.en;
  return interpolate(catalog[key] ?? catalogs.en[key] ?? key, variables);
}
