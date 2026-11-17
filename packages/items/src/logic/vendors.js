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

/**
 * The vendor family a model label names, by the first word of it that is a known vendor spelling, or null when none is.
 * Why: a claim records only the model label, so a landed item that never recorded a builder can
 * still tell which family built it [V1].
 */
export function vendorOfModel(model) {
  if (typeof model !== 'string') return null;
  for (const word of model.toLowerCase().split(/[^a-z0-9]+/u)) if (BUILTINS.has(word)) return BUILTINS.get(word);
  return null;
}

/**
 * The canonical vendor family a declared label names (any spelling of a known vendor reads as its one family), or the
 * label itself when no known vendor spelling matches. Why: seats register mixed spellings and the family guard then sees four
 * families where there are two (#9681).
 */
export function canonicalVendorFamily(label) {
  if (typeof label !== 'string' || !label.trim()) return label;
  return BUILTINS.get(label.trim().toLowerCase()) ?? label;
}
