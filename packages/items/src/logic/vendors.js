import VENDORS from './vendors.json' with { type: 'json' };

/** Small explicit vendor spellings live in vendors.json, so the core names no vendor itself; unlisted declarations retain their normalized names [V4,B26,P5]. */
const BUILTINS = new Map(Object.entries(VENDORS).flatMap(([vendor, names]) => names.map(name => [name, vendor])));

/** Retain custom unknown aliases while keeping known vendor names canonical and independent of configuration. */
export function vendorFamilyAliases(custom) {
  const index = new Map(BUILTINS);
  for (const [alias, canonical] of custom ?? []) {
    const name = alias.trim().toLowerCase(), vendor = canonical.trim().toLowerCase();
    if (!BUILTINS.has(name)) index.set(name, BUILTINS.get(vendor) ?? vendor);
  }
  return index;
}
