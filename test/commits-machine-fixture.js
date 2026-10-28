/** The lifecycle's source reader follows actual named compatibility shims into moved commit guards [C7,M1,M4]. */
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPathMap, mappedPath } from '../src/path-map.js';

const SOURCE_MAP = readPathMap(fileURLToPath(new URL('../', import.meta.url)));

/** Follow only a committed exact file identity through its whole generated shim, preserving physical relative imports. */
export function machineSourceModule(file, read) {
  const source = read(file), original = posix.normalize(posix.join('src', file));
  const target = mappedPath(SOURCE_MAP, original);
  if (target === original) return { sourceFile: file, source };
  const shim = /^\s*export\s*(\*|\{[^}]*\})\s*from\s*(['"])(\.{1,2}\/[^'"]+\.js)\2;\s*$/u.exec(source);
  assert.ok(shim && (shim[1] === '*' || shim[1].slice(1, -1).split(',').every(name => /^\s*[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*$/u.test(name)))
    && posix.normalize(posix.join(posix.dirname(original), shim[3])) === target,
  `${original} must be a whole re-export shim to its committed lifecycle source ${target}`);
  const sourceFile = posix.relative('src', target);
  return { sourceFile, source: read(sourceFile) };
}

/** Keep existing refusals visible and prove a newly planted moved-body refusal still fails the unchanged declaration. */
export function assertCommitShimRefusals(codeWalk, read, editedSource, codeProblems, machine) {
  const walk = codeWalk(read);
  for (const [entry, code] of [
    ['hooks.js#machineNameProblems', 'HOST_NAME'],
    ['infra-note.js#infraNote', 'INFRA_NOTE_REQUIRED'],
    ['guard-revert.js#guardRevertNote', 'GUARD_CANNOT_FAIL'],
    ['guard-revert.js#guardRevertNote', 'GUARD_NOT_FOUND'],
  ]) assert.ok(walk.refusalsOf(entry).has(code), `${entry} retains its actual moved refusal ${code}`);
  const planted = editedSource('../packages/commits/src/shell/hooks.js',
    /^export function machineNameProblems\(root, range, \{ refuse, say, names = machineNames\(\) \}\) \{$/m,
    "$&\n  throw new Refused('COMMIT_PACKAGE_PROBE', 'planted moved commit guard');");
  assert.ok(codeProblems(machine, planted).includes('COMMIT_PACKAGE_PROBE is raised by submit but not declared there'),
    'a compatibility shim cannot hide a newly raised lifecycle refusal');
  const realShim = read('hooks.js');
  assert.throws(() => machineSourceModule('hooks.js', file => file === 'hooks.js' ? realShim + "\nthrow new Error('extra shim code');\n" : read(file)),
    /whole re-export shim/u, 'extra shim code cannot acquire mapped-body authority');
  assert.throws(() => machineSourceModule('hooks.js', file => file === 'hooks.js' ? 'export * from "../src/board.js";\n' : read(file)),
    /whole re-export shim/u, 'a different export target cannot acquire mapped-body authority');
}
