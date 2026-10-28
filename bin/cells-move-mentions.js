/** Tell a fixture's module references to a moved source from the reads and copies a move must repoint [C7]. */

/** Escape one file name for a literal match inside a regular expression. */
function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Name every module-addressing context in which a moved path stays valid: the shim still resolves it. */
const MODULE_BEFORE = /(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*$/u;
const MODULE_THROUGH_JSON = /(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*\$\{\s*JSON\s*\.\s*stringify\s*\(\s*$/u;

/** Find the call names, outermost last, whose argument list encloses an offset, stopping at the statement. */
function enclosingCalls(code, at) {
  const calls = [];
  let depth = 0;
  for (let index = at - 1; index >= 0 && calls.length < 12; index--) {
    const char = code[index];
    if (char === ')' || char === ']' || char === '}') depth++;
    else if (char === '(' || char === '[' || char === '{') {
      if (depth) { depth--; continue; }
      if (char !== '(') break;
      const callee = /(new\s+)?([\w$.]+)\s*$/u.exec(code.slice(0, index));
      calls.push(callee ? { name: callee[2].split('.').at(-1), constructs: Boolean(callee[1]) } : { name: '', constructs: false });
    } else if (char === ';' && !depth) break;
  }
  return calls;
}

/**
 * List the string literals that name a moved source as a path a fixture could read or copy. A reference is not
 * operational when it only addresses a module (an import specifier, a file URL handed to a spawned program, a
 * template-built import, a constant used only that way) or goes through the shim-following copier.
 * @param {string} source - The fixture module text.
 * @param {{code: string, strings: Array<{start: number, end: number, text: string}>}} scanned - Its lexed form.
 * @param {string[]} basenames - File names of the moved sources.
 * @returns {Array<{start: number, end: number, text: string}>} The operational mentions.
 */
export function operationalMentions(source, scanned, basenames) {
  const { code, strings } = scanned;
  const copierNames = new Set();
  for (const match of source.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/package-files\.js['"]/gu)) {
    for (const entry of match[1].split(',')) {
      const named = /^\s*toolSourcePath(?:\s+as\s+([\w$]+))?\s*$/u.exec(entry);
      if (named) copierNames.add(named[1] ?? 'toolSourcePath');
    }
  }
  const ending = new RegExp(`(?:^|[/\\\\])(?:${basenames.map(escaped).join('|')})$`, 'u');
  const templates = strings.filter(row => source[row.start] === '`');
  return strings.filter(row => ending.test(row.text)).filter(row => {
    if (MODULE_BEFORE.test(code.slice(0, row.start))) return false;
    const calls = enclosingCalls(code, row.start);
    if (calls.some(row => copierNames.has(row.name))) return false;
    const toPath = calls.some(call => call.name === 'fileURLToPath');
    if (!toPath && calls.some(call => call.name === 'pathToFileURL' || call.constructs && call.name === 'URL')) return false;
    const template = templates.filter(outer => outer.start < row.start && row.end <= outer.end).at(-1);
    if (template) {
      const open = source.lastIndexOf('${', row.start);
      if (open > template.start && MODULE_BEFORE.test(source.slice(template.start + 1, open))) return false;
    }
    const alias = [...code.slice(0, row.start).matchAll(/\bconst\s+([\w$]+)\s*=/gu)].at(-1);
    if (alias && !/[;\n]/u.test(code.slice(alias.index + alias[0].length, row.start))) {
      const uses = [...source.matchAll(new RegExp(`(?<![\\w$.])${escaped(alias[1])}(?![\\w$])`, 'gu'))]
        .filter(use => use.index !== alias.index + alias[0].indexOf(alias[1]));
      if (uses.length && uses.every(use => {
        const before = source.slice(Math.max(0, use.index - 80), use.index);
        return MODULE_THROUGH_JSON.test(before) || MODULE_BEFORE.test(before);
      })) return false;
    }
    return true;
  });
}
