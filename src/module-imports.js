/** Parse import edges without evaluating repository code, using V8 rather than a JavaScript grammar guess [V4,C7]. */
import { spawnSync } from 'node:child_process';

/**
 * A child Node that compiles each source on its stdin as an ES module and reports, for each, whether
 * it compiles and the modules it imports statically, as V8 lists them.
 */
const PARSER = [
  "import vm from 'node:vm';",
  "import { readFileSync } from 'node:fs';",
  "const sources = JSON.parse(readFileSync(0, 'utf8'));",
  '/** Compile one source without executing repository code. */',
  'const look = (source) => {',
  '  try {',
  '    const module = new vm.SourceTextModule(source);',
  '    return { compiles: true, imports: module.moduleRequests ? module.moduleRequests.map((request) => request.specifier) : module.dependencySpecifiers };',
  '  } catch {',
  '    return { compiles: false, imports: [] };',
  '  }',
  '};',
  'process.stdout.write(JSON.stringify(sources.map(look)));',
].join('\n');

/**
 * What V8 makes of each source, all in one child process.
 *
 * @param {string[]} sources
 * @returns {{ compiles: boolean, imports: string[] }[]}
 */
function look(sources) {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', PARSER], {
    input: JSON.stringify(sources),
    encoding: 'utf8',
    maxBuffer: 2 ** 26,
  });
  if (child.status !== 0) throw new Error('V8 import parser failed: ' + (child.error?.message ?? child.stderr));
  return JSON.parse(child.stdout);
}

/** Every place the whole word import appears, in code or not; Unicode letters count as part of a word. */
const IMPORT = /(?<![\p{ID_Continue}$\u200c\u200d#])import(?![\p{ID_Continue}$\u200c\u200d])/gu;

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
 * What an import(...) call at `at` loads: its argument when that is one plain string, decoded, or
 * COMPUTED for anything else, a string whose escapes do not decode included. Only called on words
 * V8 has confirmed are import calls in code.
 *
 * @param {string} source
 * @param {number} at
 * @returns {string}
 */
function dynamicAt(source, at) {
  const argument = pastGap(pastGap(source, at + 'import'.length), 1);
  const literal = /^(['"])(?:\\[\s\S]|(?!\1)[^\\\n\r])*\1/.exec(argument);
  if (!literal) return COMPUTED;
  const after = pastGap(argument, literal[0].length)[0];
  if (after !== ')' && after !== ',') return COMPUTED;
  try {
    return new Function(`return ${literal[0]};`)();
  } catch {
    return COMPUTED;
  }
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
 * @returns {string[][]}
 */
export function importsIn(sources) {
  const calls = sources.map((source) => [...source.matchAll(IMPORT)].map((match) => match.index).filter((at) => pastGap(source, at + 'import'.length)[0] === '('));
  const variants = sources.flatMap((source, index) =>
    calls[index].flatMap((at) => [`${source.slice(0, at)}\u0000${source.slice(at)}`, `${source.slice(0, at)}1${source.slice(at + 'import'.length)}`]),
  );
  const looks = look([...sources, ...variants]);
  let next = sources.length;
  return sources.map((source, index) => {
    if (!looks[index].compiles) throw new Error('source does not compile as an ES module');
    const dynamic = calls[index].filter(() => {
      const isCode = !looks[next].compiles;
      const isCall = looks[next + 1].compiles;
      next += 2;
      return isCode && isCall;
    });
    return [...looks[index].imports, ...dynamic.map((at) => dynamicAt(source, at))];
  });
}
