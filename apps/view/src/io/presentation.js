/** Private Cost model names; imported only at a private presentation boundary [N26,P5]. */
/**
 * Name private view models and rate keys without constraining native model or family declarations.
 * Why: the alias, known-name and vendor tables are data (apps/view/data/ceilings/model-names.json) passed in as `tables`,
 * because this function reaches the browser by serializing its source and so cannot close over module data [P5].
 */
export function modelPresentation(reported, family = '', tables = {}) {
  const { aliases = {}, versionKey = '(?!)', known = {}, vendors = {}, patterns = [] } = tables;
  const named = typeof reported === 'string' ? reported.trim() : '';
  // A "/vendor" suffix is the declared family, not part of the model: "name/vendor" is "name".
  const slash = named.indexOf('/'), raw = slash > 0 ? named.slice(0, slash).trim() : named;
  if (slash > 0 && !String(family).trim()) family = named.slice(slash + 1).trim();
  // Spellings of one model share one match key, so one display name is never two rows (same family as #2091) [N26].
  const spelled = raw.toLowerCase().replace(/[\s_]+/gu, '-'), aliased = Object.hasOwn(aliases, spelled) ? aliases[spelled] : spelled;
  const key = aliased.replace(new RegExp(versionKey, 'u'), 'claude-$1-$2-$3');
  const familyKey = String(family).trim().toLowerCase();
  let name = raw, vendor = Object.hasOwn(vendors, familyKey) ? vendors[familyKey] : 'Other';
  if (Object.hasOwn(known, key)) [name, vendor] = known[key];
  else {
    const words = key.split('-').filter(Boolean), upper = (word) => word[0]?.toUpperCase() + word.slice(1);
    for (const rule of patterns) {
      const found = new RegExp(rule.match, 'u').exec(key);
      if (!found) continue;
      vendor = rule.vendor;
      if (rule.style === 'versioned') name = found[1].split('-').map(upper).join(' ') + ' ' + found[2] + '.' + found[3];
      else if (rule.style === 'acronym') name = words.map((word, index) => index === 0 && /^[a-z]{2,3}$/u.test(word) ? word.toUpperCase() : /^\d/u.test(word) || /^o\d/u.test(word) ? word : upper(word)).join(' ').replace(/^([A-Z]{2,3}) /u, '$1-');
      else name = words.map(upper).join(' ');
      break;
    }
  }
  return { key, name, vendor };
}
