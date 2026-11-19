/** Count explicit scope in a criterion; the score is a transparent hint, never a time estimate [B35,C7]. */
export function criterionSize(criterion = '', catalog = []) {
  const files = [...new Set((String(criterion).match(/(?:[\w@-]+\/)*[\w@-]+\.[A-Za-z][\w.-]*/gu) ?? []).map(file => file.replace(/\.+$/u, '')))].sort();
  const cells = new Set();
  for (const file of files) {
    const declared = catalog.find(cell => cell.paths?.includes(file) || file.startsWith(cell.root + '/'));
    const packageName = /^(packages|apps)\/([^/]+)\//u.exec(file);
    if (declared) cells.add(declared.name);
    else if (packageName) cells.add(packageName[1] === 'apps' ? `app:${packageName[2]}` : packageName[2]);
  }
  for (const match of String(criterion).matchAll(/\b(packages|apps)\/([\w-]+)/gu)) {
    const root = `${match[1]}/${match[2]}`;
    cells.add(catalog.find(cell => cell.root === root)?.name ?? (match[1] === 'apps' ? `app:${match[2]}` : match[2]));
  }
  // Separate scans keep "For cell alpha" from consuming the actual "cell alpha" declaration.
  for (const pattern of [/\bcells?\s+(?:named\s+|called\s+)?([\w:-]+(?:\s*(?:,|\band\b|&)\s*[\w:-]+)*)/gu,
    /\b([\w:-]+(?:\s*(?:,|\band\b|&)\s*[\w:-]+)*)\s+cells?\b/gu]) {
    for (const match of String(criterion).matchAll(pattern)) for (const rawName of match[1].split(/\s*(?:,|\band\b|&)\s*/u)) {
      const name = rawName.replace(/:+$/u, '');
      if (catalog.some(cell => cell.name === name)) cells.add(name);
    }
  }
  // A parenthesised number is a clause label only with no word character before it and only when the labels run 1, 2, 3 in order,
  // so a quoted count "(312)" or a call "get(1)" is prose; numbered line labels count as they always did.
  let nextLabel = 1;
  let labels = 0;
  for (const match of String(criterion).matchAll(/(?<![\w])\((\d+)\)|^\s*(\d+)\.\s+/gmu)) {
    if (match[2] !== undefined) labels += 1;
    else if (Number(match[1]) === nextLabel) { labels += 1; nextLabel += 1; }
  }
  const clauses = labels || (String(criterion).trim() ? 1 : 0);
  return { version: 1, score: files.length + cells.size + clauses, files, cells: [...cells].sort(), clauses,
    oversized: cells.size > 1 || clauses > 3 };
}

/**
 * Route new work mid. A light item now needs a recorded diagnosis (#2760), so defaulting small work to light made
 * every plain add and the post-land Main-red filer refuse DIAGNOSIS_REQUIRED; a capable seat's diagnosis makes it
 * light (#3115).
 */
export function defaultItemRoute() {
  return 'mid';
}

/** The most tagged clauses and files an item may carry and still route light [C7]. */
export const LIGHT_SHAPE_LIMIT = 3;

/**
 * The route an item's shape earns when it is filed without --route: light when it has a check, a brief, at most three
 * tagged clauses and at most three files, otherwise strong. Why: small, proven, briefed work is what a light seat can
 * build, and everything else needs a strong one; a pure function keeps `add` and `route --suggest` agreeing [C7,#3081].
 *
 * @param {{ criterion?: string, check?: string, brief?: string }} item
 * @returns {'light'|'strong'}
 */
export function shapeRoute({ criterion = '', check = '', brief = '' } = {}) {
  if (!String(check ?? '').trim() || !String(brief ?? '').trim()) return 'strong';
  const tagged = String(criterion ?? '').match(/\[(?:test|command|measurement|reasoning|manual|check)\b[^\]]*\]/gu)?.length ?? 0;
  const size = criterionSize(criterion);
  return Math.max(tagged, size.clauses) <= LIGHT_SHAPE_LIMIT && size.files.length <= LIGHT_SHAPE_LIMIT ? 'light' : 'strong';
}
