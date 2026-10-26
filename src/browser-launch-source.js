/** Recognize Chrome-bearing process arguments in executable code, not generated fixture programs [C7,O5]. */
import { lex } from './js-lex.js';
import { makeCallableCommandChecker } from './browser-call-values.js';

const PROCESS_CALLS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork',
  'runFixtureChild', 'runFixtureChildAsync', 'startFixtureChild', 'Worker', 'SharedWorker',
  'runInContext', 'runInNewContext', 'runInThisContext', 'compileFunction', 'SourceTextModule', 'Script']);
const CHROME = /PULLBOARD_CHROME|google-chrome|Google Chrome|\bchrome\b|chromium|puppeteer|playwright/iu;
const WORD = /[$A-Z_a-z][$\w]*/gu;

/** Decode only character escapes for a conservative executable-name comparison; never evaluate source. */
function browserText(text) {
  const plain = text.replace(/\\u\{([\da-f]+)\}|\\u([\da-f]{4})|\\x([\da-f]{2})/giu,
    (whole, point, unicode, byte) => {
      const value = parseInt(point ?? unicode ?? byte, 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : whole;
    });
  return CHROME.test(plain);
}

/** Find the end of a balanced argument/expression span in lexer's offset-preserving executable code. */
function closing(code, start) {
  const pairs = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
  const stack = [];
  for (let at = start; at < code.length; at += 1) {
    const char = code[at];
    if (pairs.has(char)) stack.push(pairs.get(char));
    else if (')]}'.includes(char)) {
      if (stack.pop() !== char) return null;
      if (!stack.length) return at;
    }
  }
  return null;
}

/** Static aliases remain process calls; unknown imports are still handled by admission's existing graph walk. */
function callNames(source, code) {
  const names = new Set(PROCESS_CALLS);
  // A quoted generated import can add a name here, but cannot create an executable call in `code`.
  for (const match of source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*(['"])(?:node:(?:child_process|worker_threads|cluster|vm|module)|[^'"\n]*fixture-child\.js)\2/gu)) {
    for (const binding of match[1].split(',')) {
      const [original, alias] = binding.trim().split(/\s+as\s+/u);
      if (names.has(original) && alias) names.add(alias);
    }
  }
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([$\w]+)\s*=\s*(?:[$\w]+\s*\.\s*)?([$\w]+)\s*[;,]/gu)) {
    if (names.has(match[2])) names.add(match[1]);
  }
  return names;
}

/** Namespace imports identify real process methods separately from unrelated methods such as RegExp.exec. */
function processNamespaces(source) {
  const namespaces = new Set();
  for (const match of source.matchAll(/\bimport\s+(?:\*\s+as\s+)?([$A-Z_a-z][$\w]*)\s+from\s*(['"])(?:node:(?:child_process|worker_threads|cluster|vm|module)|[^'"\n]*fixture-child\.js)\2/gu)) {
    namespaces.add(match[1]);
  }
  return namespaces;
}

/** Unknown command members stay bound without tainting unrelated calls in the same source. */
function unresolvedCommandValue(expression, links) {
  const compact = expression.replace(/^\s*await\s+/u, '').replace(/\s/gu, '');
  // A conditional's predicate is not one of the executable values it returns.
  let nested = 0;
  for (let at = 0; at < compact.length; at += 1) {
    if ('([{'.includes(compact[at])) {
      const end = closing(compact, at);
      if (end === null) return true;
      at = end;
    } else if (compact[at] === '?' && !['?', '.'].includes(compact[at + 1]) && compact[at - 1] !== '?') {
      const start = at + 1;
      for (at = start; at < compact.length; at += 1) {
        if ('([{'.includes(compact[at])) {
          const end = closing(compact, at);
          if (end === null) return true;
          at = end;
        } else if (compact[at] === '?' && !['?', '.'].includes(compact[at + 1]) && compact[at - 1] !== '?') nested += 1;
        else if (compact[at] === ':' && nested-- === 0) {
          return unresolvedCommandValue(compact.slice(start, at), links)
            || unresolvedCommandValue(compact.slice(at + 1), links);
        }
      }
      return true;
    }
  }
  // Only returned values and bare aliases feed the command graph, never a conditional's predicate.
  const linked = /^([$A-Z_a-z][$\w]*)(?=$|(?:\?\.)?\()/u.exec(compact);
  if (linked && links) links.add(linked[1]);
  // Calls and object/template construction do not return the value of each member they read.
  // In particular, a pid used to build a directory name is not an executable-valued alias.
  let brackets = 0;
  for (const char of compact) {
    if (char === '[') brackets += 1;
    else if (char === ']') brackets -= 1;
    else if (!brackets && '({`'.includes(char)) return false;
  }
  const members = compact.matchAll(/(?<![\w$.])[$A-Z_a-z][$\w]*(?:(?:\?\.|\.)[$A-Z_a-z][$\w]*|(?:\?\.)?\[[\s\S]*\])+/gu);
  return [...members].some(match => !['process.execPath', 'process.argv[0]'].includes(match[0])
    // Existing arbitrary environment-value holes are exercised by the runtime guard.
    // Known browser environment names are detected separately by browserIn.
    && !/^process\.env(?:\.|\[|\?\.)/u.test(match[0])
    && compact[match.index + match[0].length] !== '(');
}

/** End one expression without consuming another argument or a surrounding function body. */
function expressionEnd(code, start, newlineEnds = true) {
  let end = start;
  let conditional = 0;
  while (end < code.length && !';,)]}'.includes(code[end])) {
    if (newlineEnds && code[end] === '\n' && !conditional && !code.slice(end + 1).trimStart().startsWith('?')) break;
    if ('([{'.includes(code[end])) {
      const close = closing(code, end);
      if (close === null) return null;
      end = close + 1;
    } else {
      if (code[end] === '?' && !['?', '.'].includes(code[end + 1]) && code[end - 1] !== '?') conditional += 1;
      else if (code[end] === ':' && conditional) conditional -= 1;
      end += 1;
    }
  }
  return end;
}

/** Read callable result spans without evaluating either a function body or its generated source. */
function callableReturns(code, start, end) {
  let at = start + code.slice(start, end).search(/\S/u);
  const declared = /^(?:async\s+)?function(?:\s+[$A-Z_a-z][$\w]*)?\s*\(/u.exec(code.slice(at, end));
  if (declared) at += declared[0].length - 1;
  else {
    const asynchronous = /^async\s+/u.exec(code.slice(at, end));
    if (asynchronous) at += asynchronous[0].length;
  }
  if (code[at] === '(') {
    const parameters = closing(code, at);
    if (parameters === null) return [];
    at = parameters + 1;
  } else {
    const parameter = /^[$A-Z_a-z][$\w]*/u.exec(code.slice(at, end));
    if (!parameter || declared) return [];
    at += parameter[0].length;
  }
  at += code.slice(at, end).search(/\S/u);
  if (!declared) {
    if (code.slice(at, at + 2) !== '=>') return [];
    at += 2;
    at += code.slice(at, end).search(/\S/u);
    if (code[at] !== '{') return [[at, end]];
  }
  if (code[at] !== '{') return [];
  const last = closing(code, at);
  if (last === null) return [];
  return [...code.slice(at + 1, last).matchAll(/\breturn[ \t]+/gu)].flatMap(match => {
    const first = at + 1 + match.index + match[0].length;
    const final = expressionEnd(code, first);
    return final === null ? [] : [[first, final]];
  });
}

/** A reviewed exception matches one complete call inside its named function, never a whole module. */
function reviewedCall(source, code, call, end, executors) {
  const compact = text => text.replace(/\s/gu, '');
  for (const executor of executors) {
    if (compact(source.slice(call.at, end + 1)) !== compact(executor.site)) continue;
    const pattern = new RegExp(`\\bfunction\\s+${executor.function}\\s*\\(`, 'gu');
    for (const match of code.matchAll(pattern)) {
      const parameters = closing(code, match.index + match[0].length - 1);
      if (parameters === null) continue;
      const body = parameters + 1 + code.slice(parameters + 1).search(/\S/u);
      if (code[body] !== '{') continue;
      const last = closing(code, body);
      if (last !== null && call.at > body && end < last) return true;
    }
  }
  return false;
}

/**
 * Determine whether executable process calls can reach a Chrome argument. Local literal bindings are
 * followed conservatively, without scope-sensitive elimination. A program supplied to a real process
 * (including node -e or a shell) remains an argument, unlike a program merely written to a fixture file.
 * Template interpolations remain executable in lex.code. This is not an arbitrary JavaScript evaluator.
 *
 * @param {string} source
 * @param {{function:string,site:string,reason:string}[]} [reviewedExecutors]
 * @returns {boolean}
 */
export function sourceLaunchesBrowser(source, reviewedExecutors = []) {
  const { code, strings } = lex(source);
  const names = callNames(source, code);
  const namespaces = processNamespaces(source);
  const bindings = new Map();
  /** A span's literals or executable environment references can name a browser. */
  const browserIn = (start, end) => CHROME.test(code.slice(start, end))
    || strings.some(string => string.start >= start && string.start < end && browserText(string.text));
  // Union executable identifier assignments, including later writes and conditional branches.
  // Never let a later non-browser value erase a possible browser value; strings/comments are blank in code.
  for (const match of code.matchAll(/(?<![\w$.])([$A-Z_a-z][$\w]*)\s*=(?!=|>)/gu)) {
    // A property write is not a write to the same-named local identifier, even with whitespace.
    if (code.slice(0, match.index).trimEnd().endsWith('.')) continue;
    const start = match.index + match[0].length;
    const end = expressionEnd(code, start);
    if (end === null) return CHROME.test(source);
    const prior = bindings.get(match[1]) ?? { browser: false, unresolved: false, aliases: new Set(), dependencies: new Set(), expressions: [] };
    prior.expressions.push(code.slice(start, end));
    prior.browser ||= browserIn(start, end);
    prior.unresolved ||= unresolvedCommandValue(code.slice(start, end), prior.aliases);
    for (const [first, last] of callableReturns(code, start, end)) {
      prior.unresolved ||= unresolvedCommandValue(code.slice(first, last), prior.aliases);
    }
    for (const word of code.slice(start, end).matchAll(WORD)) prior.dependencies.add(word[0]);
    bindings.set(match[1], prior);
  }
  // Named function declarations have no assignment RHS. Retain their returned values so a
  // function-produced executable follows the same local value graph as an assigned literal.
  for (const match of code.matchAll(/\bfunction\s+([$A-Z_a-z][$\w]*)\s*\(/gu)) {
    const parameters = closing(code, match.index + match[0].length - 1);
    if (parameters === null) continue;
    const body = parameters + 1 + code.slice(parameters + 1).search(/\S/u);
    if (code[body] !== '{') continue;
    const last = closing(code, body);
    if (last === null) continue;
    const value = bindings.get(match[1]) ?? { browser: false, unresolved: false, aliases: new Set(), dependencies: new Set(), expressions: [] };
    for (const returned of code.slice(body + 1, last).matchAll(/\breturn\s+(?![\r\n])/gu)) {
      const start = body + 1 + returned.index + returned[0].length;
      const end = expressionEnd(code, start);
      if (end === null) continue;
      value.browser ||= browserIn(start, end);
      value.unresolved ||= unresolvedCommandValue(code.slice(start, end), value.aliases);
      for (const word of code.slice(start, end).matchAll(WORD)) value.dependencies.add(word[0]);
    }
    bindings.set(match[1], value);
  }
  /** Follow only the finite local binding graph, retaining a possible browser through aliases. */
  function namedBrowser(name, seen = new Set(), command = false) {
    if (seen.has(name)) return false;
    seen.add(name);
    const binding = bindings.get(name);
    return Boolean(binding && (binding.browser || command && binding.unresolved
      || [...(command ? binding.aliases : binding.dependencies)].some(next => namedBrowser(next, seen, command))));
  }
  const callableCommand = makeCallableCommandChecker(code, bindings, { unresolved: unresolvedCommandValue,
    named: name => namedBrowser(name, new Set(), true) });
  const calls = [...code.matchAll(/(?<![\w$])([$A-Z_a-z][$\w]*)\s*(?:\?\.)?\s*\(/gu)]
    .filter(match => names.has(match[1])).map(match => {
      const before = code.slice(0, match.index).trimEnd();
      const owner = /([$A-Z_a-z][$\w]*)\s*(?:\?\.|\.)$/u.exec(before)?.[1];
      return { at: match.index, start: match.index + match[0].length - 1,
        unknown: !before.endsWith('.') || namespaces.has(owner) };
    });
  for (const namespace of namespaces) {
    const escaped = namespace.replace(/[$]/gu, '\\$&');
    const pattern = new RegExp(`(?<![\\w$.])${escaped}\\s*(?:\\?\\.)?\\s*\\[\\s*(['"])([$A-Z_a-z][$\\w]*)\\1\\s*\\]\\s*(?:\\?\\.)?\\s*\\(`, 'gu');
    for (const match of source.matchAll(pattern)) {
      if (PROCESS_CALLS.has(match[2]) && code.slice(match.index, match.index + namespace.length) === namespace) {
        calls.push({ at: match.index, start: match.index + match[0].length - 1, unknown: true });
      }
    }
  }
  for (const call of calls) {
    const { start } = call;
    const end = closing(code, start);
    if (end === null) return CHROME.test(source);
    if (browserIn(start + 1, end)) return true;
    if ([...code.slice(start + 1, end).matchAll(WORD)].some(word => namedBrowser(word[0]))) return true;
    // A regex's .exec is not the imported process capability. Unknown-value admission
    // applies to bare process bindings and imported process namespaces, not unrelated methods.
    if (call.unknown && !reviewedCall(source, code, call, end, reviewedExecutors)) {
      const commandEnd = expressionEnd(code, start + 1, false);
      if (commandEnd === null) return true;
      const command = code.slice(start + 1, commandEnd);
      if (unresolvedCommandValue(command) || callableCommand(command)
        || [...command.matchAll(WORD)].some(word => namedBrowser(word[0], new Set(), true))) return true;
    }
  }
  // Computed/dynamic process access has no complete static call binding: keep Chrome-capable sources bound.
  if (/\b(?:getBuiltinModule|eval|Function)\s*\(|\b(?:process|require)\s*\[|\]\s*(?:\?\.)?\s*\(|\.\s*(?:call|apply|bind)\s*\(|\\u(?:[\da-f]{4}|\{[\da-f]+\})/iu.test(code)
      && CHROME.test(source)) return true;
  return false;
}
