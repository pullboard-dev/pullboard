/** No next: line of next, show, submit, claim or status suggests --wait; submit points at next --take [C7,#2905]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { successfulNext } from '../../../../../packages/config/index.js';
import { DEFAULT_NEXT_STEPS } from '../../../../../packages/state/index.js';
import { RECORDED_GENERIC_NEXT } from '../../../../../packages/state/index.js';
import { refuseNextIdle } from '../../../index.js';
import { NEXT_STEPS } from '../../../src/logic/step/words.js';
import { nextStepFor } from '../../../src/logic/step/words.js';

test('cli.logic-step-words.the-default-next-step-of-every-command: the default next step of every command is next --take, never a --wait hint [C7,#2905]', () => {
  for (const command of ['next', 'show', 'submit', 'claim', 'status', 'list'])
    assert.doesNotMatch(successfulNext(command, {}), /--wait/u, command);
  assert.equal(successfulNext('submit', {}), 'pullboard next --take');
});

test('cli.logic-step-words.an-idle-next-names-next-take-in: an idle next names next --take, in its message and its next: line [C7,#2905]', () => {
  assert.doesNotMatch(DEFAULT_NEXT_STEPS.NOTHING_FREE, /--wait/u);
  const out = [];
  let refusal;
  refuseNextIdle({ refusal: (error) => { refusal = error; }, err: (line) => out.push(line) }, ['no item is free'], ['no item is free'], { minutes: 0, verify: false });
  assert.doesNotMatch(out.join('\n'), /--wait/u);
  assert.doesNotMatch(refusal.message, /--wait/u);
});

/** Each refusal the seat-facing commands raise: its code, the message its raise site builds with placeholder ids, and the next argument it passes (null when it passes none). */
const SEAT_REFUSALS = [
  ['MAIN_NOT_COMPOSED', 'the unrecorded recovered submission has no proof for current main; run pullboard inbox to synchronize its original receipt, or ask the coordinator to resolve the pending move before a fresh submit; the original request is retained', null],
  ['RUNNER_WAIT_DEADLINE', 'gate.runnersOnly is on and no runner is registered, so the gate for #7 has nowhere to run', 'register a runner with pullboard runner add, or turn the setting off with pullboard settings gate.runnersOnly off, then retry'],
  ['NOT_YOURS', 'this folder belongs to item #7; submit that item from here', null],
  ['NOT_YOURS', 'claim this item before submitting it', null],
  ['NOT_YOURS', 'item #7 is not claimed by you; claim it first', null],
  ['NOT_YOURS', 'only the coordinator releases another holder with --stale', null],
  ['NOT_YOURS', 'this item has no current claim to release as stale', null],
  ['DIRTY', 'commit your changes first; the gate must check what you submit', null],
  ['DIRTY', 'item folder /work/item-7 has uncommitted changes; build on the runner, and leave the coordinator folder untouched', null],
  ['UNTRACKED', 'commit or ignore 2 untracked file(s), e.g. notes.txt', null],
  ['NO_COMMIT', 'nothing committed yet', null],
  ['NO_COMMIT', 'nothing committed yet; commit the item work in this clone, then submit', null],
  ['CHECK_FILE_MISSING', 'the frozen check names test/a.test.js, which commit abcdef123456 does not contain; this commit added no files; name the test as the check does, or ask the coordinator to correct the check', null],
  ['GENERATED_STALE', 'the generated file is stale; next: run the generator yourself, commit, and submit again', null],
  ['CRITERIA_CHANGED', 'the spec rows #7 cites changed after it was claimed, so no verifier could judge it; release the item and claim it again', null],
  ['ITEM_PATCH_FORMAT', 'supply a regular companion patch of at most eight MiB', null],
  ['ITEM_PATCH_AUTHOR', 'name a registered author in another owning lane', null],
  ['RUNNER_NOT_REGISTERED', 'item folder runner mini.local is not registered; run pullboard runner list, or unset PULLBOARD_ITEM_FOLDER_RUNNER', null],
  ['HOSTED_BRANCH_MISMATCH', 'item folder /work/item-7 is on main, not the claimed branch core/item-7; switch it back and submit again', null],
  ['HOSTED_PUSH_FAILED', "the coordinator branch core/item-7 is at nothing, not the runner's pushed abcdef123456; submit again", null],
  ['USAGE', 'use pullboard submit <id> --companion <patch-file> --key <key> --author <owning-seat>', null],
  ['USAGE', 'use pullboard verify <id> --compare without an accept or reject verdict', null],
  ['USAGE', '--on requires an ordinary release with --reason BLOCKED', null],
  ['USAGE', 'run pullboard next --take without an item id, --build, --verify or --as', null],
  ['USAGE', 'choose a build or a review: pullboard next --build or pullboard next --verify', null],
  ['USAGE', 'give an item id only with --verify: pullboard next --verify <id>', null],
  ['USAGE', '--wait is a number of minutes from 0 to 240', null],
  ['BAD_DEPENDENCIES', '--on needs one or more local item ids', null],
  ['REVIEW_RELEASE_REASON', 'a review release names why it was dropped: --reason BAR|FAMILY|INFRA|TOO_LARGE (--note still gives the one-line reason)', 'run pullboard release <id> --reason BAR|FAMILY|INFRA|TOO_LARGE --note "why"'],
  ['NOT_AT_COMMIT', 'check out the submitted commit first: cd /work/item-7 && git switch --detach abcdef123456', null],
  ['NOT_AT_COMMIT', 'the reviewed checkout moved during its check; restore the clean reviewed HEAD and retry verification', null],
  ['NOT_LANDED', 'item #7 already has a accepted verdict by core-1; a forced-landed item takes one verdict', null],
  ['NOT_SUBMITTED', 'item #7 is claimed, not submitted', null],
  ['BAD_VERDICT_REVIEW', 'the submitted builder cannot be determined from native history; restore its submission before review', null],
  ['CHECK_UNVERIFIED', 'the frozen check could not be verified at the submitted commit; restore the install or check environment, then retry verification', null],
  ['CHECK_RED', 'the frozen item check is red at the submitted commit (check); check.install may be needed for dependencies; reject with the failing behavior or ask the builder to fix and resubmit', null],
  ['RUNNER_SOURCE', 'the remote check step needs its admitted runner; register a runner or submit in the foreground', null],
  ['RUNNER_SOURCE', 'cell analysis needs its admitted remote runner', null],
  ['RUNNER_TOOLING_CRASH', 'the pinned check tooling crashed on the runner with TypeError; the same main will crash again, so shout the coordinator with this line; kept in /work/out', null],
  ['RUNNER_RESULT_INVALID', 'the remote check step did not return a complete pinned result; read /work/out and submit again', null],
  ['RUNNER_RESULT_INVALID', 'the runner test plan names no proof files; submit again', null],
  ['RUNNER_RESULT_INVALID', 'remote cell analysis output does not match its authenticated receipt', null],
  ['CELLS_SUBMIT', "the board's cut authority changed while the remote analysis ran; submit again from a fresh snapshot", null],
  ['CELLS_SUBMIT', 'remote cell result or trusted cut authority changed; retry from a fresh snapshot', null],
  ['GATE_RED', 'preflight is red; no runner was queued. Fix the named source, commit, and submit again:\nfile.js: bad', 'fix the named source, commit, and run pullboard submit <id> again'],
  ['SUBMISSION_CHANGED', 'gate job gate:7:abc:x passed but #7 is still claimed', null],
  ['SUBMISSION_WAIT_TIMEOUT', 'gate wait deadline reached for #7; job gate:7:abc:x has not settled', null],
  ['DETACHED_HEAD', 'HEAD is detached; check out the branch for #7, push it to the trunk remote and submit again', null],
  ['COMMIT_NOT_PUSHED', 'abcdef123456 is not pushed to the trunk remote; git push -u origin HEAD, then submit again', null],
  ['NO_MAIN_REF', 'this clone has not fetched the host main; git fetch origin, merge origin/main, push and submit again', null],
  ['NOT_ON_MAIN', 'abcdef123456 does not descend from the host main 123456abcdef; merge main, push, and submit again', null],
  ['BAD_REQUEST', 'only a submit from a seat joined by board.url carries commits; remove commits from this move', null],
  ['NO_TRUNK_REMOTE', 'this board has no trunk.remote to check a pushed commit against; set trunk.remote, or send the commits with board.commits bundle', null],
  ['REMOTE_COMMIT_MISSING', 'abcdef123456 is not on refs/heads/work at the trunk remote; push it (git push <remote> HEAD:refs/heads/work) and submit again', null],
  ['REMOTE_REF_MISMATCH', 'refs/heads/work at the trunk remote is at 123456abcdef, which does not contain abcdef123456; push abcdef123456 to refs/heads/work and submit again', null],
  ['COMMITS_REFUSED', 'the board host could not record abcdef123456; submit again from the clone', null],
  ['NO_POLICY', 'the item or admitted main history cannot be read; restore Git history before submitting again', null],
  ['SUBMIT_RED_LOOP', 'two red test gates still match this item code (a.js); change the failing code before another submit', null],
  ['SUBMIT_HANDOFF_CHANGED', 'the queued gate for #7 changed; run pullboard show 7 to read its actual result', null],
  ['SUBMIT_HANDOFF_RESULT', 'the queued worker observation is unavailable; run pullboard show 7; its gate may still be running', null],
  ['ITEM_WORK_IN_SEAT', 'item work for #7 is committed in the seat checkout /work/seat; item work is built in its item folder /work/item-7', null],
  ['HOOK_LOOSENING_UNLOADED', 'a staged change reached the row-loosening check without loading it', 'report this refusal to the coordinator with pullboard shout'],
  ['PUSH_UNSHARDED', 'the push cannot run as shard jobs: no runner. next: fix that, then push again (or turn push.refuseUnsharded off to allow the one-command gate)', null],
];

test('cli.logic-step-words.seat-refusal-table: clause 1: every refusal the claim, commit, submit, verify, release and next paths raise maps to its own step, never the recorded generic line, the service-owner fallback or a next --wait hint [C7,#11708]', () => {
  for (const [code, message, next] of SEAT_REFUSALS) {
    const step = nextStepFor({ code, ...(next ? { next } : {}) }, message, { caller: 'seat' });
    const label = `${code}: ${message.slice(0, 60)}`;
    assert.ok(step && step !== RECORDED_GENERIC_NEXT, `${label} has a specific step`);
    assert.doesNotMatch(step, /ask the service owner/u, label);
    assert.doesNotMatch(step, /next --wait/u, label);
  }
});

test('cli.logic-step-words.seat-refusal-table-in-catalog: clause 2: every code in the seat refusal table has a NEXT_STEPS row, or carries its step in its message or next argument, so the table and the catalog cannot drift apart [C7,#11708]', () => {
  for (const [code, message, next] of SEAT_REFUSALS) {
    const unknownCode = nextStepFor({ code: 'NO_ROW_FOR_THIS_CODE' }, message, { caller: 'seat' });
    const carried = Boolean(next) || !/ask the service owner/u.test(unknownCode);
    assert.ok(Boolean(NEXT_STEPS[code]) || carried, `${code}: ${message.slice(0, 60)} has a catalog row or a step of its own`);
  }
});

test('cli.logic-step-words.submit-path-steps-named: clause 1: nextStepFor returns the step a submit-path refusal message spells out (push, fetch, claim, start, submit again), never the service-owner fallback [C7,#2331]', () => {
  const cases = [
    ['COMMIT_NOT_PUSHED', 'abc123def456 is not pushed to the trunk remote; git push -u origin HEAD, then submit again', 'git push -u origin HEAD, then submit again'],
    ['NO_MAIN_REF', 'this clone has not fetched the host main; git fetch origin, merge origin/main, push and submit again', 'git fetch origin, merge origin/main, push and submit again'],
    ['REMOTE_REF_MISMATCH', 'refs/heads/x at the trunk remote is at aaa, which does not contain bbb; push bbb to refs/heads/x and submit again', 'push bbb to refs/heads/x and submit again'],
    ['COMMITS_REFUSED', 'the board host could not record abc123def456; submit again from the clone', 'submit again from the clone'],
    ['TEST_NO_CLAIM', 'agent holds 2 claims on the board at board.url; a test receipt records on exactly one; claim one with pullboard claim <id>, or run pullboard next', 'claim one with pullboard claim <id>, or run pullboard next'],
    ['TEST_JOB_UNCLAIMED', 'no runner took test job j within 30s; start one with pullboard runner serve <board-url>, then run pullboard test again', 'start one with pullboard runner serve <board-url>, then run pullboard test again'],
  ];
  for (const [code, message, step] of cases) {
    const next = nextStepFor({ code }, message);
    assert.equal(next, step, code);
    assert.doesNotMatch(next, /service owner/u, code);
  }
});

test('cli.logic-step-words.existing-steps-unchanged: clause 2: a clause that began with an existing repair word is still taken, and a message with no step still falls to its NEXT_STEPS row [C7,#2331]', () => {
  assert.equal(nextStepFor({ code: 'X_CODE' }, 'it broke; run pullboard status'), 'run pullboard status');
  assert.equal(nextStepFor({ code: 'NOTHING_FREE' }, 'no item is free'), DEFAULT_NEXT_STEPS.NOTHING_FREE);
});
