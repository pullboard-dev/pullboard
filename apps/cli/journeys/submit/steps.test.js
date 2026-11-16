/** @pullboard-test-input source-tree */
/** Refusals give concrete recovery steps that work in real checkouts [P4,I1,I2]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { Refused } from '../../../../packages/kernel/light.js';
import {
  recordedRefusal,
  refusalFromReceipt,
  RECORDED_GENERIC_NEXT,
} from '../../../../packages/state/index.js';
import { refusalDocument } from '../../index.js';
import { commandOutput as lightCommandOutput } from '../../../../packages/config/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import { REPOSITORY } from '../../tests/fixtures/source.js';
import { movedSourceFiles } from '../../tests/fixtures/source.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Keep both command streams in an assertion so a refusal is never hidden by fixture diagnostics. */
function succeeded(result) {
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  return result;
}

/** File a real build with a frozen check that fails only when the fixture arms its gate. */
async function addBuild(box, repo, title, check) {
  const result = succeeded(await fixtureAdd(box.runLocal, repo, 'web', title, '--specs', 'G1',
    '--criterion', 'the real fixture gate passes', '--check', check,
    '--route', 'strong', '--wait', '--json'));
  return JSON.parse(result.out).item.item_id;
}

test('clause 2: every refusal names a next step that works [P4,I1,I2]', async () => {
  const codes = new Set(['API_LISTEN', 'CORE_BARE', 'VIEW_SIGN_IN_STOPPED']);
  for (const file of movedSourceFiles()) {
    const source = readFileSync(join(REPOSITORY, file), 'utf8');
    for (const match of source.matchAll(/new Refused\(\s*['"]([A-Z][A-Z0-9_]*)['"]/gu)) codes.add(match[1]);
  }
  for (const code of codes) {
    const { next } = refusalDocument(new Refused(code, 'This operation was refused.')).error;
    assert.ok(next.trim(), `${code} supplies a recovery action`);
    assert.doesNotMatch(next, /Run pullboard help, correct the reported problem/u, `${code} has its own recovery`);
  }
  const { nextSteps$NEXT_STEPS: NEXT_STEPS } = await import('../../index.js');
  for (const code of codes) assert.ok(Object.hasOwn(NEXT_STEPS, code), `${code} has an explicit recovery entry`);
  assert.equal(refusalDocument({ code: 'FUTURE_REMOTE_RULE', message: 'The service refused.', next: 'ask the service owner to restore this board' }).error.next,
    'ask the service owner to restore this board', 'remote recovery guidance survives serialization');
  assert.equal(refusalDocument(new Refused('SNAPSHOT_REQUIRED', 'fetch the latest sealed state, then resume after its sequence')).error.next,
    'fetch the latest sealed state with GET /api/v2/boards/:id/state, then resume events after its sequence', 'the relay snapshot refusal names the exact call [H5]');
  assert.match(refusalDocument(new Refused('FUTURE_REMOTE_RULE', 'The service refused.')).error.next, /service owner.*FUTURE_REMOTE_RULE/u,
    'an unknown remote rule names its owner and code rather than inventing a command');
  assert.equal(refusalDocument(new Refused('REMOTE_COORDINATOR_MODEL',
    "the coordinator's model is declared on its own checkout; run pullboard join coordinator there")).error.next,
  'run pullboard join coordinator there', 'a coordinator description does not hide the later recovery action');
  assert.equal(refusalDocument(new Refused('PENDING_REFREEZE',
    'item #12 has a pending correction.\nnext: pullboard refreeze 12')).error.next,
  'pullboard refreeze 12', 'an existing specific next line survives serialization');
  assert.equal(refusalDocument(new Refused('GATE_RED',
    'the submission proof is red.\nnext: land #12 first, then submit again', 'fix the gate and retry')).error.next,
  'land #12 first, then submit again', 'an inherited failure retains its specific recovery');
  assert.equal(refusalDocument(new Refused('GATE_RED',
    'the submission proof is red.\nnext: land #12 first, then submit again')).error.message,
  'the submission proof is red.\nnext: land #12 first, then submit again', 'JSON retains the original message');
  assert.equal(refusalDocument(new Refused('GATE_RED',
    'reported output:\nnext: an unrelated printed line\nend of report', 'repair this fixture')).error.next,
  'repair this fixture', 'nonterminal report text cannot override contextual recovery');
  assert.equal(refusalDocument(new Refused('GATE_RED',
    'the submission proof is red.', 'repair this fixture, commit, and submit again')).error.next,
  'repair this fixture, commit, and submit again', 'contextual recovery remains explicit without a message next line');
  const oldReceipt = recordedRefusal(new Refused('NOT_SUBMITTED', 'item #12 is verified, not submitted'));
  assert.equal(oldReceipt.next, RECORDED_GENERIC_NEXT, 'canonical receipts keep their original wire guidance');
  assert.doesNotMatch(refusalDocument(refusalFromReceipt(oldReceipt)).error.next, /Run pullboard help, correct the reported problem/u,
    'presenting an old receipt computes current guidance');
  assert.equal(refusalDocument(new Refused(oldReceipt.code, oldReceipt.message, oldReceipt.next)).error.next,
    refusalDocument(refusalFromReceipt(oldReceipt)).error.next, 'an old generic remote fallback is never displayed');
  const oldDiagnostic = recordedRefusal(new Refused('GATE_RED', 'the proof is red; fix it, commit, submit again\nfailure: fixture output'));
  assert.match(oldDiagnostic.next, /\nfailure: fixture output/u, 'the historical serializer retains its multiline value');
  assert.equal(refusalDocument(refusalFromReceipt(oldDiagnostic)).error.next, 'fix it, commit, submit again',
    'a derived historical diagnostic tail is not repeated in the current footer');
  const remoteStep = { code: 'FUTURE_REMOTE_RULE', message: 'The service refused.', next: 'ask the service owner to restore this board' };
  assert.equal(refusalDocument(refusalFromReceipt(remoteStep)).error.next, remoteStep.next,
    'a remote explicit action distinct from historical derivation survives reconstruction');

  const box = e2e.sandbox();
  box.env.PULLBOARD_MODEL = 'Refusal Fixture Model';
  // One inline script with no sandbox path in it, so every sandbox shares one project shape and copies the template [C7].
  const script = 'if (require("node:fs").existsSync("web/RED")) { console.log("GATE_FAILURE_MARKER"); process.exit(1); }';
  const gate = `'${process.execPath.replaceAll("'", "'\\''")}' -e '${script}'`;
  const { repo, web } = e2e.project(gate, box);
  const id = await addBuild(box, repo, 'Independent review recovery', gate);
  succeeded(await box.runLocal(web, 'claim', String(id)));
  mkdirSync(join(web, 'web'), { recursive: true });
  writeFileSync(join(web, 'web', 'receipt.txt'), 'a real build\n');
  box.git(web, 'add', '-A');
  box.git(web, 'commit', '-q', '-m', 'test: build review fixture [G1]');
  succeeded(await box.runLocal(web, 'submit', String(id)));

  const mainRefusal = await box.runLocal(repo, 'next', '--verify', String(id), '--json');
  assert.equal(mainRefusal.code, 1, `${mainRefusal.out}\n${mainRefusal.err}`);
  const mainError = JSON.parse(mainRefusal.out).error;
  assert.equal(mainError.code, 'MAIN_IS_COORDINATOR');
  assert.match(mainError.next, /pullboard worktree \w+ --model/u);
  assert.doesNotMatch(mainError.next, /git worktree add/u, 'a pullboard command makes the review seat (#7925)');
  assert.match(mainError.next, /reviewer.*(?:did not|not).*build/iu, 'the step requires an independent reviewer');
  const reviewer = join(repo, '.claude', 'worktrees', 'reviewer');
  box.git(repo, 'worktree', 'add', '-q', '--detach', reviewer, 'HEAD');
  // Item #1 was filed on the strong route, so its reviewer joins strong to be offered the review [V4].
  succeeded(await fixtureJoin(box.runLocal, reviewer, 'web', '--model', 'Independent Reviewer Model', '--route', 'strong'));
  const selected = succeeded(await box.runLocal(reviewer, 'next', '--verify', String(id), '--json'));
  assert.equal(JSON.parse(selected.out).item.item_id, id, 'the recovery reaches review without SELF_VERIFY');

  const gateBox = e2e.sandbox();
  gateBox.env.PULLBOARD_MODEL = 'Gate Fixture Model';
  const { repo: gateRepo, web: gateWeb } = e2e.project(gate, gateBox);
  const redId = await addBuild(gateBox, gateRepo, 'Gate failure recovery', gate);
  succeeded(await gateBox.runLocal(gateWeb, 'claim', String(redId)));
  mkdirSync(join(gateWeb, 'web'), { recursive: true });
  writeFileSync(join(gateWeb, 'web', 'receipt.txt'), 'a real build\n');
  writeFileSync(join(gateWeb, 'web', 'RED'), 'armed\n');
  gateBox.git(gateWeb, 'add', '-A');
  gateBox.git(gateWeb, 'commit', '-q', '-m', 'test: arm gate fixture [G1]');
  // A pulled submit queues its gate and returns; the fixture command returns once the local runner settled it, so show reads the red verdict [C7].
  const queued = await gateBox.runLocal(gateWeb, 'submit', String(redId));
  assert.equal(queued.code, 0, `${queued.out}\n${queued.err}`);
  const red = await gateBox.runLocal(gateWeb, 'show', String(redId), '--json', '--no-next');
  assert.equal(red.code, 0, `${red.out}\n${red.err}`);
  const redJob = JSON.parse(red.out).gateJob;
  assert.equal(redJob?.gate?.green, false, `the pulled gate is red: ${red.out}`);
  assert.equal((JSON.stringify(redJob).match(/GATE_FAILURE_MARKER/gu) ?? []).length >= 1, true, `the failure report names the marker\n${red.out}`);
  rmSync(join(gateWeb, 'web', 'RED'));
  gateBox.git(gateWeb, 'add', '-u');
  gateBox.git(gateWeb, 'commit', '-q', '-m', 'test: fix gate fixture [G1]');
  succeeded(await gateBox.runLocal(gateWeb, 'submit', String(redId)));

  box.env.CODEX_THREAD_ID = 'main-owner-session';
  // The coordinator is always strong; join refuses BAD_ROUTE when its model maps to no tier and the route defaults to mid.
  succeeded(await fixtureJoin(box.runLocal, repo, 'coordinator', '--model', 'Coordinator Fixture Model', '--route', 'strong'));
  const bindingPath = join(repo, '.git', 'pullboard-checkout-session.json');
  const binding = readFileSync(bindingPath, 'utf8');
  box.env.CODEX_THREAD_ID = 'new-agent-session';
  const foreign = await box.runLocal(repo, 'claim', String(id), '--json');
  assert.equal(foreign.code, 1, `${foreign.out}\n${foreign.err}`);
  const foreignError = JSON.parse(foreign.out).error;
  assert.equal(foreignError.code, 'NOT_YOUR_CHECKOUT');
  assert.match(foreignError.next, /git worktree add --detach/u, 'recovery does not call Pullboard from the blocked checkout');
  const recovery = join(repo, '.claude', 'worktrees', 'new-agent');
  box.git(repo, 'worktree', 'add', '-q', '--detach', recovery, 'HEAD');
  succeeded(await fixtureJoin(box.runLocal, recovery, 'web', '--model', 'New Agent Fixture Model'));
  succeeded(await box.runLocal(recovery, 'whoami', '--json'));
  assert.equal(readFileSync(bindingPath, 'utf8'), binding, 'recovery leaves the main owner binding unchanged');
});


test('the light collector preserves prepared JSON refusal documents and a single success output [A1,P4,B26,C7]', async () => {
  const cases = [
    { code: 'NO_ITEM', message: 'No item exists.' },
    { code: 'FUTURE_REMOTE_RULE', message: 'The service refused.', next: 'ask its owner to restore the board' },
    { code: 'SPEC_NOT_APPROVED', message: 'The rule is pending; ask the person to approve it.' },
    refusalFromReceipt(recordedRefusal(new Refused('GATE_RED', 'gate red; fix it, commit, submit again'))),
  ];
  for (const error of cases) {
    let text = '';
    const io = lightCommandOutput(['show', '1', '--json'], { stdout: { write(value) { text += value; } }, stderr: { write() {} } },
      { loadRefusal: async () => (await import('../../index.js')).refusalDocument });
    io.caller('seat', '/fixture');
    io.refusal(error);
    await io.prepareRefusal();
    io.flush(1);
    io.flush(1);
    assert.deepEqual(JSON.parse(text), refusalDocument(error, { caller: 'seat' }), 'lazy preparation preserves the synchronous public envelope and caller guidance');
  }
  let text = '';
  const io = lightCommandOutput(['version', '--json'], { stdout: { write(value) { text += value; } }, stderr: { write() {} } });
  io.result({ release: '0.9.2' });
  io.flush(0);
  io.flush(0);
  assert.deepEqual(JSON.parse(text), { version: 1, release: '0.9.2' }, 'success needs no refusal preparation and flushes once');
});
