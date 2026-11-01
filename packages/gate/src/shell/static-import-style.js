/** Read actual static import bindings without executing repository source [C7]. */
import vm from 'node:vm';

const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$))*`;
const IDENTIFIER = String.raw`[\p{ID_Start}_$][\p{ID_Continue}$\u200c\u200d]*`;
const NAMED = new RegExp(String.raw`\bimport${GAP}(?:(?<default>${IDENTIFIER})${GAP},${GAP})?\{(?<bindings>[^{}]*)\}`, 'dgu');
const NAMESPACE = new RegExp(String.raw`\bimport${GAP}(?<default>${IDENTIFIER})${GAP},${GAP}\*${GAP}as${GAP}(?<namespace>${IDENTIFIER})`, 'dgu');

/** Keep line positions while removing comments inside an import's binding list. */
function withoutComments(text) {
  return text.replace(/(['"])(?:\\[\s\S]|(?!\1)[^\\])*\1|\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?\*\//gu,
    (part) => part.startsWith('/') ? part.replace(/[^\r\n\u2028\u2029]/gu, ' ') : part);
}

/** Read binding starts, treating quoted exported names and aliases as one binding each. */
function bindingOffsets(text) {
  const clean = withoutComments(text);
  const starts = [];
  let start = 0;
  let quote = null;
  for (let index = 0; index <= clean.length; index++) {
    const character = clean[index];
    if (quote) {
      if (character === '\\') index++;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ',' || index === clean.length) {
      const first = /\S/u.exec(clean.slice(start, index));
      if (first) starts.push(start + first.index);
      start = index + 1;
    }
  }
  return starts;
}

/** Compile syntax without linking modules, treating embedded source text as data. */
function compiles(source) {
  try { new vm.SourceTextModule(source); return true; } catch { return false; }
}

/** Report only multiple actual bindings on one physical import line. */
export function importStyleViolations(sources) {
  if (typeof vm.SourceTextModule !== 'function') throw new Error('run static checks with node --experimental-vm-modules');
  return sources.flatMap(({ file, source }) => {
    if (!compiles(source)) throw new Error(`${file}: source does not compile`);
    const named = [...source.matchAll(NAMED)].map(match => ({ at: match.index, offsets: [
      ...(match.groups.default ? [match.indices.groups.default[0]] : []),
      ...bindingOffsets(match.groups.bindings).map(offset => match.indices.groups.bindings[0] + offset),
    ] }));
    const spaces = [...source.matchAll(NAMESPACE)].map(match => ({ at: match.index,
      offsets: [match.indices.groups.default[0], match.indices.groups.namespace[0]] }));
    return [...named, ...spaces].flatMap(({ at, offsets }) => {
      if (compiles(source.slice(0, at) + '\u0000' + source.slice(at))) return [];
      const lines = new Map();
      for (const offset of offsets) {
        const line = source.slice(0, offset).split(/\r\n|[\n\r\u2028\u2029]/u).length;
        lines.set(line, (lines.get(line) ?? 0) + 1);
      }
      return [...lines].filter(([, count]) => count > 1).map(([line, count]) => ({ file, line, count }));
    });
  });
}
