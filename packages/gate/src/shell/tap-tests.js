/**
 * Read which committed tests a Node TAP run names [C7,D1]. Both the flake diagnostics and the gate's own run receipt
 * use it, so a failing test has one identity everywhere: its committed file and its structured name.
 */
import {
  realpathSync,
} from 'node:fs';
import {
  isAbsolute,
  relative,
} from 'node:path';
import { tryGit } from '../../../../src/git.js';

/** Resolve live aliases; deleted private checks already carry their physical execution root. */
function physicalPath(path) {
  try { return realpathSync(path); }
  catch { return path; }
}

/** Read structured Node TAP blocks only; nested selectors and cancelled parents stay unsupported. */
export function tapTests(output, root) {
  const rows = [];
  let active;
  for (const raw of output.split('\n')) {
    const match = /^(\s*)(not ok|ok)\s+\d+\s+-\s+(.*)$/u.exec(raw);
    if (match) {
      active = { name: match[3], passed: match[2] === 'ok', indent: match[1].length, file: null, skip: /\s+#\s*(?:SKIP|TODO)\b/iu.test(match[3]), type: null, failureType: null };
      rows.push(active); continue;
    }
    if (!active) continue;
    const field = /^(\s*)(location|type|failureType):\s*(.*?)\s*$/u.exec(raw);
    if (!field || field[1].length !== active.indent + 2) continue;
    const value = field[3].replace(/^(['"])(.*)\1$/u, '$2');
    if (field[2] === 'location') {
      const path = value.replace(/:\d+(?::\d+)?$/u, '');
      const file = isAbsolute(path) ? relative(physicalPath(root), physicalPath(path)) : path.replace(/^\.\//u, '');
      if (file && !file.startsWith('../') && !file.includes('\\')) active.file = file;
    } else active[field[2]] = value;
  }
  return rows;
}

/** Confirm the file is a committed regular test at the pinned source, without reading a live substitute. */
export function committedTest(root, commit, file) {
  if (!file || !/\.(?:[cm]?js)$/u.test(file) || file.startsWith('/') || file.includes('\\') || file.split('/').some(part => !part || part === '..' || part === '.')) return false;
  const result = tryGit(root, ['--literal-pathspecs', 'ls-tree', '-z', commit, '--', file]);
  return result.status === 0 && /^(?:100644|100755) blob [a-f0-9]+\t/u.test(result.stdout) && result.stdout.split('\0').filter(Boolean).length === 1;
}

const SINGLE_FILE_CHECK = /^node --test(?: --test-force-exit)? (?:\.\/)?([A-Za-z0-9_][A-Za-z0-9_./-]*\.test\.[cm]?js)$/u;
const SKIPPED = /\s+#\s*(?:SKIP|TODO)\b.*$/iu;

/** Node's TAP escapes a name's backslash, hash and line breaks; restore the name the test declared. */
function tapName(text) {
  return text.replace(SKIPPED, '').replace(/\\(.)/gu, (_, char) => (char === 'n' ? '\n' : char === 'r' ? '\r' : char));
}

/**
 * The executed cases of a check that is exactly `node --test <one file>`, read from the gate's own TAP output, or null.
 * Why: a plain `node --test` check prints no outcome frames, so its exact-head receipt kept file-level passes only and
 * review could not see the clause case pass (five INSUFFICIENT_EVIDENCE rejects in 45 minutes, 7 Nov) [C7,V4]. Node's
 * TAP names a passing case's file only through the one file the check runs, so a check of several files stays null.
 * Every leaf case must be accounted for: the rows must equal the run's own `# tests` trailer, and a cancelled case,
 * a nested selector or a name TAP cannot carry leaves the whole run unread rather than partly read.
 *
 * @param {string} command - the exact command the gate ran
 * @param {string} output - that run's captured output
 * @returns {{file:string,name:string,passed:boolean,skipped:boolean}[] | null}
 */
export function singleFileTapOutcomes(command, output) {
  const file = SINGLE_FILE_CHECK.exec(String(command ?? '').trim())?.[1];
  if (!file || typeof output !== 'string') return null;
  const trailers = [...output.matchAll(/^# tests (\d+)$/gmu)];
  if (trailers.length !== 1) return null;
  const rows = tapTests(output, process.cwd()).filter(row => row.type !== 'suite');
  if (rows.length !== Number(trailers[0][1])
    || rows.some(row => row.indent !== 0 && row.indent % 4 !== 0 || ['cancelledByParent', 'testAborted', 'subtestsFailed'].includes(row.failureType))) return null;
  return rows.map(row => ({ file, name: tapName(row.name), passed: row.passed, skipped: row.skip }));
}
