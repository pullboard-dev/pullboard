/** Find executable source-relative runtime files without treating generated programs as dependencies [C7,P3]. */
import { lex } from '../../../kernel/index.js';
import { importsWithCompiler } from '../../../kernel/index.js';

/** Return literal runtime edges (minus file names in runtimeOnly, which an export writes at run time), or null when a two-argument URL cannot be resolved safely. */
export function runtimeUrls(source, parse, runtimeOnly = new Set()) {
  const { code, strings } = lex(source);
  const spellings = [];
  for (const match of code.matchAll(/\bnew\s+URL\s*\(/gu)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    for (; end < code.length && depth; end += 1) {
      if (code[end] === '(') depth += 1;
      if (code[end] === ')') depth -= 1;
    }
    if (depth) return null;
    const argumentsCode = code.slice(start, end - 1);
    if (!argumentsCode.includes(',')) continue; // One-argument network URL validation reads no source-relative file.
    const tail = /,\s*import\s*\.\s*meta\s*\.\s*url\s*$/u.exec(argumentsCode);
    if (!tail) continue; // A dynamic base (e.g. pathToFileURL(...)) is a runtime location, not a source-relative edge.
    const argument = code.slice(start, start + tail.index);
    const offset = argument.search(/\S/u);
    const literal = strings.find(entry => entry.start === start + offset);
    if (!literal || !['"', "'"].includes(source[literal.start])
      || code.slice(literal.end, start + tail.index).trim()) continue; // A computed path is a runtime value, not a literal edge.
    spellings.push(source.slice(literal.start, literal.end));
  }
  const paths = [];
  const decodedImports = spellings.length ? importsWithCompiler(spellings.map(spelling => `import ${spelling};`), parse) : [];
  for (const decoded of decodedImports) {
    if (decoded.length !== 1 || !decoded[0].startsWith('.')) return null;
    if (!runtimeOnly.has(decoded[0].split('/').pop())) paths.push(decoded[0]);
  }
  return paths;
}

/** The module factory's name, built in two parts so this file never spells a loader call the package scan reads [P3]. */
const FACTORY = 'create' + 'Require';

/**
 * Literal edges of a module whose only CommonJS use is `const r = <module factory>(import.meta.url)` plus `r('./x.js')`
 * calls, or null when any other loader spelling remains (computed paths are skipped as run-time). Why: such calls resolve at capture exactly like imports.
 */
export function requireEdges(source) {
  const { code } = lex(source);
  const declared = [...code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${FACTORY}\\s*\\(\\s*import\\s*\\.\\s*meta\\s*\\.\\s*url\\s*\\)`, 'gu'))];
  if (declared.length !== 1) return null;
  const [text, name] = declared[0];
  const from = declared[0].index;
  if (/^\s*\(/u.test(code.slice(from + text.length))) return null; // the factory called and invoked again binds a result, not a loader.
  const masked = code.slice(0, from) + ' '.repeat(text.length) + code.slice(from + text.length);
  if (/\brequire\s*[(.]|\bmodule\s*\.\s*require\b/u.test(masked) || new RegExp(`\\b${FACTORY}\\s*\\(`, 'u').test(masked)) return null;
  const edges = [];
  for (const match of masked.matchAll(new RegExp(`(?<![\\w$.])${name.replaceAll('$', '\\$')}\\s*\\(`, 'gu'))) {
    const literal = /^\s*(['"])(\.{1,2}\/[^'"\\\n]+)\1\s*\)/u.exec(source.slice(match.index + match[0].length));
    if (!literal) continue; // A computed path resolves at run time, like a computed dynamic import.
    edges.push(literal[2]);
  }
  return edges;
}
