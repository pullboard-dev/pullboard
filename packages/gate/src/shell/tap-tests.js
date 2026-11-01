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
