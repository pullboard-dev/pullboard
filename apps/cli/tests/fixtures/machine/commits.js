/** The lifecycle's source reader follows actual named compatibility shims into moved commit guards [C7,M1,M4]. */
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lex } from '../../../../../packages/kernel/index.js';
import {
  readPathMap,
  mappedPath,
} from '../../../../../packages/codemap/index.js';

const SOURCE_MAP = new Map([...readPathMap(fileURLToPath(new URL('../../../../../', import.meta.url)))].filter(([, target]) => target.startsWith('packages/commits/')));

/** The re-export shim the commits move generated for src/hooks.js, kept as text to exercise the alias reader. */
const GENERATED_HOOKS_SHIM = 'export { HOOKS, HOOKS_DIR, HOOK_MARK, FIX_NOTE, commitMsgProblems, computerName, machineNames, machineNameProblems, commitCitationWarnings, stagedPaths, addedLines, secretsIn, matchesPattern, blockedPaths, preCommitProblems, deletedGateProblems, preMergeHookProblems, unwiredHookProblems, applyFixers, deletedRowProblems, prePushProblems, pushesTrunk, hookScript, installHooks } from "../../../../../packages/commits/index.js";\n';

/** Follow only this moved cell's committed exact aliases through whole generated shims, preserving other cells' readers. */
export function machineSourceModule(file, read) {
  const source = read(file), original = posix.normalize(`src/${file}`);
  const target = mappedPath(SOURCE_MAP, original);
  if (target === original) return { sourceFile: file, source };
  const shim = /^\s*export\s*(\*|\{[^}]*\})\s*from\s*(['"])(\.{1,2}\/[^'"]+\.js)\2;\s*$/u.exec(source);
  assert.ok(shim && (shim[1] === '*' || shim[1].slice(1, -1).split(',').every(name => /^\s*[A-Za-z_$][\w$]*\s*$/u.test(name)))
    && posix.normalize(posix.join(posix.dirname(original), shim[3])) === target,
  `${original} must be a whole re-export shim to its committed lifecycle source ${target}`);
  const sourceFile = posix.relative('src', target);
  const body = read(sourceFile);
  const declarations = [...lex(body).code.matchAll(/\bexport\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/gu)];
  assert.equal(declarations.length, [...lex(body).code.matchAll(/\bexport\b/gu)].length,
    `${target} must retain direct named declarations for this bounded lifecycle reader`);
  if (shim[1] !== '*') assert.deepEqual(shim[1].slice(1, -1).split(',').map(name => name.trim()).sort(),
    declarations.map(match => match[1]).sort(), `${original} must preserve every mapped public binding`);
  return { sourceFile, source: body };
}

/** Keep existing refusals visible and prove a newly planted moved-body refusal still fails the unchanged declaration. */
export function assertCommitShimRefusals(codeWalk, read, editedSource, codeProblems, machine) {
  const walk = codeWalk(read);
  for (const [entry, code] of [
    ['../packages/commits/src/io/hooks.js#machineNameProblems', 'HOST_NAME'],
    ['../packages/commits/src/io/revert.js#guardRevertNote', 'GUARD_CANNOT_FAIL'],
    ['../packages/commits/src/io/revert.js#guardRevertNote', 'GUARD_NOT_FOUND'],
  ]) assert.ok(walk.refusalsOf(entry).has(code), `${entry} retains its actual moved refusal ${code}`);
  const planted = editedSource('../packages/commits/src/io/hooks.js',
    /^export function machineNameProblems\(root, range, \{ refuse, say, names = machineNames\(\) \}\) \{$/m,
    "$&\n  throw new Refused('COMMIT_PACKAGE_PROBE', 'planted moved commit guard');");
  assert.ok(codeProblems(machine, planted).includes('COMMIT_PACKAGE_PROBE is raised by submit but not declared there'),
    'a compatibility shim cannot hide a newly raised lifecycle refusal');
  // The shims are deleted from src/; the reader's alias rules are still proven against the shape the move generated.
  const realShim = GENERATED_HOOKS_SHIM;
  for (const badShim of [realShim.replace('machineNameProblems,', 'machineNames as machineNameProblems,'),
    realShim.replace('machineNameProblems,', '')]) {
    assert.throws(() => machineSourceModule('hooks.js', file => file === 'hooks.js' ? badShim : read(file)),
      /whole re-export shim|preserve every mapped public binding/u,
      'renamed or omitted public bindings cannot acquire mapped-body authority');
  }
  assert.throws(() => machineSourceModule('hooks.js', file => file === 'hooks.js' ? realShim + "\nthrow new Error('extra shim code');\n" : read(file)),
    /whole re-export shim/u, 'extra shim code cannot acquire mapped-body authority');
  assert.throws(() => machineSourceModule('hooks.js', file => file === 'hooks.js' ? 'export * from "../../../../../packages/store/index.js";\n' : read(file)),
    /whole re-export shim/u, 'a different export target cannot acquire mapped-body authority');
}
