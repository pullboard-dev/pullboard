/** Find executable source-relative runtime files without treating generated programs as dependencies [C7,P3]. */
import { lex } from '../../../kernel/index.js';
import { importsWithCompiler } from '../../../kernel/index.js';

/** Return literal runtime edges, or null when a two-argument URL cannot be resolved safely. */
export function runtimeUrls(source, parse) {
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
    if (!tail) return null;
    const argument = code.slice(start, start + tail.index);
    const offset = argument.search(/\S/u);
    const literal = strings.find(entry => entry.start === start + offset);
    if (!literal || !['"', "'"].includes(source[literal.start])
      || code.slice(literal.end, start + tail.index).trim()) return null;
    spellings.push(source.slice(literal.start, literal.end));
  }
  const paths = [];
  const decodedImports = spellings.length ? importsWithCompiler(spellings.map(spelling => `import ${spelling};`), parse) : [];
  for (const decoded of decodedImports) {
    if (decoded.length !== 1 || !decoded[0].startsWith('.')) return null;
    paths.push(decoded[0]);
  }
  return paths;
}
