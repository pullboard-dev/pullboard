/** Import-edge probes consume compiler observations without executing candidate source [C7,P3]. */
/** Every place the whole word import appears, in code or not; Unicode letters count as part of a word. */
const IMPORT = /(?<![\p{ID_Continue}$\u200c\u200d#])import(?![\p{ID_Continue}$\u200c\u200d])/gu;
/** CommonJS loader words, matched with the same identifier boundaries as import. */
const COMMON_JS = /(?<![\p{ID_Continue}$\u200c\u200d#])(?:require|createRequire)(?![\p{ID_Continue}$\u200c\u200d])/gu;
/** Unicode escapes can spell any identifier character, so V8 probes them without decoding source. */
const UNICODE_ESCAPE = /\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]{1,6}\})/gu;

/** Whitespace and comments, which may sit between import, its parenthesis and its argument. A line comment ends at any line terminator. */
const GAP = /^(?:\s|\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\/)*/;

/** What a dynamic import of anything but a plain string loads: unknown, so never node: or relative. */
const COMPUTED = '(computed)';

/**
 * The text from `at` on, past whitespace and comments.
 *
 * @param {string} source
 * @param {number} at
 * @returns {string}
 */
function pastGap(source, at) {
  const rest = source.slice(at);
  return rest.slice(GAP.exec(rest)[0].length);
}

/**
 * The bounded string-literal spelling in one confirmed dynamic import, or null for executable expressions.
 * Decoding is deferred so all literals share one compile-only V8 batch.
 *
 * @param {string} source
 * @param {number} at
 * @returns {string | null}
 */
function dynamicLiteralAt(source, at) {
  const argument = pastGap(pastGap(source, at + 'import'.length), 1);
  const literal = /^(['"])(?:\\[\s\S]|(?!\1)[^\\\n\r])*\1/.exec(argument);
  if (!literal) return null;
  const after = pastGap(argument, literal[0].length)[0];
  return after === ')' || after === ',' ? literal[0] : null;
}

/**
 * Every module each source imports. V8 lists the static ones: import and export-from statements and
 * side-effect imports. For each import followed by a parenthesis, V8 also decides two things: a NUL
 * put before the word breaks the module only when the word is code, not text in a string, template,
 * comment or regular expression; and putting 1 in its place still compiles only when the word is a
 * call, not a property name after a dot. Only then is the argument read, and an argument that is not
 * one plain string is reported as COMPUTED, which no rule allows. A method named import, in a class
 * or object, still reads as a call: the scan errs toward a false alarm, never a miss.
 *
 * @param {string[]} sources - Each one a module that compiles.
 * @param {(sources: string[]) => Array<{compiles: boolean, imports: string[]}>} parse - The caller supplies actual compile-only V8 observations.
 * @returns {string[][]}
 */
export function importsWithCompiler(sources, parse) {
  const calls = sources.map((source) => [...source.matchAll(IMPORT)].map((match) => match.index).filter((at) => pastGap(source, at + 'import'.length)[0] === '('));
  const variants = sources.flatMap((source, index) =>
    calls[index].flatMap((at) => [`${source.slice(0, at)}\u0000${source.slice(at)}`, `${source.slice(0, at)}1${source.slice(at + 'import'.length)}`]),
  );
  const looks = parse([...sources, ...variants]);
  let next = sources.length;
  const edges = sources.map((source, index) => {
    if (!looks[index].compiles) throw new Error('source does not compile as an ES module');
    const dynamic = calls[index].filter(() => {
      const isCode = !looks[next].compiles;
      const isCall = looks[next + 1].compiles;
      next += 2;
      return isCode && isCall;
    });
    return { imports: looks[index].imports, literals: dynamic.map(at => dynamicLiteralAt(source, at)) };
  });
  const literals = [...new Set(edges.flatMap(edge => edge.literals.filter(Boolean)))];
  const decoded = literals.length ? parse(literals.map(literal => `import ${literal};`)) : [];
  const values = new Map(literals.map((literal, index) => [literal, decoded[index].imports[0] ?? COMPUTED]));
  return edges.map(edge => [...edge.imports, ...edge.literals.map(literal => values.get(literal) ?? COMPUTED)]);
}

/** Detect actual CommonJS loader words without executing source; invalid modules are conservatively unknown.
 *
 * @param {string[]} sources
 * @param {(sources: string[]) => Array<{compiles: boolean, imports: string[]}>} parse - The caller supplies actual compile-only V8 observations.
 * @returns {boolean[]}
 */
export function commonJsWithCompiler(sources, parse) {
  const occurrences = sources.map((source) => [...new Set([
    ...[...source.matchAll(COMMON_JS)].map((match) => match.index),
    ...[...source.matchAll(UNICODE_ESCAPE)].map((match) => match.index),
  ])]);
  const variants = sources.flatMap((source, index) =>
    occurrences[index].map((at) => {
      // Poison after an escape: before a range endpoint, NUL can invalidate a harmless regex range.
      const escaped = /^\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]{1,6}\})/u.exec(source.slice(at));
      const cut = at + (escaped?.[0].length ?? 0);
      return `${source.slice(0, cut)}\u0000${source.slice(cut)}`;
    }),
  );
  const looks = parse([...sources, ...variants]);
  let next = sources.length;
  return sources.map((source, index) => {
    if (!looks[index].compiles) return true;
    let found = false;
    for (const _at of occurrences[index]) {
      if (!looks[next].compiles) found = true;
      next += 1;
    }
    return found;
  });
}

