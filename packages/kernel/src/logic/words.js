import { Refused } from './refused.js';
/** Read literal shell words without interpreting expansions or operators. */
/** Split a literal shell command into words, refusing expansion, operators, and incomplete quoting. */
export function literalShellWords(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const words = [];
  let word = '';
  let started = false;
  let quote = '';
  for (const character of command) {
    if (character === '\n' || character === '\r') return null;
    if (quote === "'") {
      if (character === "'") quote = '';
      else word += character;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = '';
      else if ('$`\\'.includes(character)) return null;
      else word += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (/\s/u.test(character)) {
      if (started) { words.push(word); word = ''; started = false; }
      continue;
    }
    if (';&|<>$`(){}*?[]\\'.includes(character)) return null;
    word += character;
    started = true;
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}


/**
 * Refuse a check whose pipeline would hide a red proof's exit status [C7,V4]. Kept out of board.js,
 * which is already over the 1500-line cap (C9).
 */

/**
 * Keep only the check's top-level shell code, blanking everything inside quotes and $( ) substitutions while
 * keeping each offset; a # comment is blanked too. A $( ) inside double quotes opens its own code context, so
 * "$(printf '%s' "$out" | grep x)" stays one quoted word; a plain ( ) subshell is top-level code, since it exits with
 * its last stage [C7,V4].
 *
 * @param {string} command
 * @returns {string}
 */
function topLevel(command) {
  const stack = ['code'];
  let out = '';
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const context = stack.at(-1);
    const top = stack.length === 1;
    if (context === "'") {
      if (char === "'") stack.pop();
      out += ' ';
    } else if (char === '\\') {
      out += i + 1 < command.length ? '  ' : ' ';
      i++;
    } else if (context === '"') {
      if (char === '"') stack.pop();
      else if (char === '$' && command[i + 1] === '(') { stack.push('$('); out += ' '; i++; }
      out += ' ';
    } else if (char === '#' && (i === 0 || /[\s;&|()]/u.test(command[i - 1]))) {
      // A shell comment runs to the end of its line and is never code.
      const end = command.indexOf('\n', i);
      const stop = end < 0 ? command.length : end;
      out += ' '.repeat(stop - i);
      i = stop - 1;
    } else if (char === "'" || char === '"') { stack.push(char); out += top ? char : ' '; }
    else if (char === '$' && command[i + 1] === '(') { stack.push('$('); out += top ? '$(' : '  '; i++; }
    else if (char === '(' && context === '$(') { stack.push('$('); out += ' '; }
    else if (char === ')' && context === '$(') { stack.pop(); out += stack.length === 1 ? ')' : ' '; }
    else out += top ? char : ' ';
  }
  return out;
}

/**
 * Split a check into its pipelines at ;, &&, ||, &, newlines and ( ) group edges in its top-level code; pipes inside
 * quotes, comments or a $( ) substitution are not the check's own. Each pipeline keeps the separator before it and
 * its ( ) group depth, so a later reader knows whether it always runs [C7,V4].
 *
 * @param {string} command
 * @returns {{ start: number, end: number, pipes: number[], after: string, depth: number }[]}
 */
function pipelines(command) {
  const shell = topLevel(command);
  const found = [];
  let depth = 0;
  let current = { start: 0, pipes: [], after: 'start', depth };
  const cut = (at, next, separator) => { found.push({ ...current, end: at }); current = { start: next, pipes: [], after: separator, depth }; };
  for (let i = 0; i < shell.length; i++) {
    const char = shell[i];
    if (char === '$' && shell[i + 1] === '(') { i = shell.indexOf(')', i); if (i < 0) break; }
    else if (char === '(') { depth++; cut(i, i + 1, '('); }
    else if (char === ')') { depth = Math.max(0, depth - 1); cut(i, i + 1, ')'); }
    else if (char === '|' && shell[i + 1] === '|') { cut(i, i + 2, '||'); i++; }
    else if (char === '&' && shell[i + 1] === '&') { cut(i, i + 2, '&&'); i++; }
    else if (char === '|') current.pipes.push(i);
    else if ((char === '&' && shell[i - 1] !== '>' && shell[i + 1] !== '>') || char === ';' || char === '\n') cut(i, i + 1, char);
  }
  cut(shell.length, shell.length, 'end');
  return found;
}

/**
 * Name the final stage of the first pipeline that would hide a check's exit status, or null when none does. A
 * pipeline is exempt in two cases only: the check's first command is set -o pipefail (alone or with other set flags,
 * so it always runs) and nothing in the check clears it with a set +o form; or the pipeline's first stage prints a
 * value captured earlier with NAME=$(...), the out=$(...) form this board uses. An untested capture excuses nothing.
 * A nested shell (sh -c, bash -c), eval or script file is not read: the rule reads the check's own text [C7,V4].
 *
 * @param {string} command
 * @returns {string | null}
 */
function maskingStage(command) {
  const all = pipelines(command);
  const statements = all.filter(pipeline => command.slice(pipeline.start, pipeline.end).trim());
  const cleared = statements.some(pipeline => /^\s*set\s+(?:[-+]\S+\s+)*\+\S*o\s+pipefail\b/u.test(command.slice(pipeline.start, pipeline.end)));
  const first = statements[0];
  const pipefail = !cleared && first !== undefined && first.after === 'start' && !first.pipes.length
    && /^\s*set\s+(?:[-+]\S+\s+)*-\S*o\s+pipefail\b/u.test(command.slice(first.start, first.end));
  if (pipefail) return null;
  const captured = new Set();
  for (const pipeline of all) {
    const assignment = /^\s*(\w+)="?\$\(/u.exec(command.slice(pipeline.start, pipeline.end));
    if (assignment) captured.add(assignment[1]);
    if (!pipeline.pipes.length) continue;
    const head = command.slice(pipeline.start, pipeline.pipes[0]);
    const tested = /^\s*(?:printf|echo)\b/u.test(head)
      && [...head.matchAll(/\$\{?(\w+)\}?/gu)].some((match) => captured.has(match[1]));
    if (tested) continue;
    return /^\s*([^\s;&|)}]+)/u.exec(command.slice(pipeline.pipes.at(-1) + 1))?.[1] ?? 'a later stage';
  }
  return null;
}

/**
 * Refuse a check whose pipeline would hide a red proof, naming the fix (CHECK_MASKS_EXIT) [C7,V4].
 * Without the refusal the board records a failing command as passed.
 *
 * @param {string} check
 */
export function refuseMaskedExit(check) {
  const stage = maskingStage(check ?? '');
  if (stage === null) return;
  throw new Refused('CHECK_MASKS_EXIT', `the check pipes its proof into ${stage}, so a failing proof still exits 0; set pipefail (set -o pipefail), run the proof alone, or capture the output first and test it: out=$(<proof>); printf '%s\\n' "$out" | grep -Eq '<expected>'`);
}
