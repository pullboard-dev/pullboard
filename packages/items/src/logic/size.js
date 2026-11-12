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
  const labels = [...String(criterion).matchAll(/\((\d+)\)|^\s*(\d+)\.\s+/gmu)];
  const clauses = labels.length || (String(criterion).trim() ? 1 : 0);
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
