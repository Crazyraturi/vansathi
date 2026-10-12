import fs from 'node:fs';
const en = JSON.parse(fs.readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
const hi = JSON.parse(fs.readFileSync(new URL('../locales/hi.json', import.meta.url), 'utf8'));
const keys = value => Object.entries(value).flatMap(([key, child]) => typeof child === 'object' && child !== null ? keys(child).map(nested => `${key}.${nested}`) : [key]).sort();
const a = keys(en), b = keys(hi);
const missing = a.filter(key => !b.includes(key));
const extra = b.filter(key => !a.includes(key));
if (missing.length || extra.length) {
  console.error(`Locale keys differ. Missing in hi: ${missing.join(', ') || 'none'}; extra in hi: ${extra.join(', ') || 'none'}`);
  process.exitCode = 1;
} else console.log(`Locale keys match (${a.length}).`);
