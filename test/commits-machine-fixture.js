/** The lifecycle's source reader follows actual named compatibility shims into moved commit guards [C7,M1,M4]. */
import assert from 'node:assert/strict';

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
}
