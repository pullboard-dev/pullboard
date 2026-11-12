/** @pullboard-world-pin: clause 1 reads the shared fixture and the admission test themselves. */
/** A check green on main holds the item until the person accepts it; fixture joins name a model [C7,V4,B26,P6]. */
import assert from 'node:assert/strict';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { nativeBoardPorts } from '../../../lib/index.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import {
  CHECK_ACCEPT_ENGINE,
  acceptCheck,
  checkDigest,
} from '../../../../packages/verify/index.js';
import { refusePersonMove } from '../../../../packages/mcp/index.js';
import {
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from '../../../../packages/kernel/index.js';
import {
  BOARD_FILE,
  project,
  fileCheck,
  addChecked,
  showItem,
  cleanupFixtures,
  withBoard,
} from '../../tests/fixtures/check-baseline.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

/** Run the CLI through production dispatch in this process; same result shape as box.run [C7]. */
async function local(box, cwd, args, input, options = {}) {
  return runCliInProcess(args, { cwd, env: options.env ?? box.env, ...(input === undefined ? {} : { input }) });
}

const { relaySenderProblem } = nativeBoardPorts().enginePorts;

after(cleanupFixtures);

/** The person's own terminal: the fixture environment with every agent and SSH marker dropped. */
function personEnv(env) {
  const clean = { ...env };
  for (const marker of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete clean[marker];
  return clean;
}

/** Read one refused CLI move's JSON error, asserting it exited 1. */
function refusal(result, label) {
  assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout).error;
}

/** Send one move through the local API handler on a chosen channel, as the view and agent API do. */
function apiMove(box, move, channel, env) {
  const apiModule = new URL('../../../../packages/api/src/io/main.js', import.meta.url).href;
  const cliModule = new URL('../../tests/fixtures/native.js', import.meta.url).href;
  const source = `
    const { executeMove } = await import(${JSON.stringify(apiModule)});
    const { main } = await import(${JSON.stringify(cliModule)});
    const { openBoard, openBoardForRead } = await import(${JSON.stringify(new URL('../../../lib/src/logic/native.js', import.meta.url).href)});
    const { moveArgs } = await import(${JSON.stringify(new URL('../../../../packages/person/index.js', import.meta.url).href)});
    const apiBoardOpeners = { moveArgs, openBoard, openBoardForRead };
    const response = await executeMove(process.cwd(), ${JSON.stringify(move)}, main, undefined, ${JSON.stringify(channel)}, undefined, apiBoardOpeners);
    process.stdout.write(JSON.stringify(response));
  `;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  return JSON.parse(child.stdout);
}

/** Commit one tracked change in an agent worktree so submit has a clean head to prove. */
function commitIn(box, cwd, content, message) {
  writeFileSync(join(cwd, 'web', 'result.txt'), `${content}\n`);
  box.git(cwd, 'add', 'web/result.txt');
  box.git(cwd, 'commit', '-q', '-m', message);
}

test('[V2,V4,B26,P6] a check green on main holds the item until the person accepts it', async () => {
  const box = project({ content: 'green', worktrees: true, hold: true });
  const env = personEnv(box.env);
  const file = join(box.repo, BOARD_FILE);
  assert.deepEqual(box.initChecks, { provesNothing: 'hold' }, 'pullboard init writes checks.provesNothing "hold" for a new board');
  const main = box.git(box.repo, 'rev-parse', 'refs/heads/main');
  const green = fileCheck('green', 'held-check-marker.txt');
  const { item } = addChecked(box, 'Held green check', green);
  const id = String(item.item_id);
  assert.equal(item.item_check_baseline.result, 'green');

  const held = refusal(await local(box, box.web, ['claim', id, '--json']), 'claim');
  assert.equal(held.code, 'CRITERION_PROVES_NOTHING', 'claiming an item whose check is green on main is refused');
  assert.ok(held.message.includes(green), `the refusal names the check: ${held.message}`);
  assert.ok(held.message.includes(`main ${main.slice(0, 12)}`), `the refusal names main: ${held.message}`);
  assert.match(held.next, new RegExp(`pullboard check accept ${id}`, 'u'), 'the next step names the person’s move');

  const shell = refusal(await local(box, box.repo, ['check', 'accept', id, '--json'], undefined, { env: { ...env, CLAUDECODE: '1' } }), 'agent shell');
  assert.equal(shell.code, 'B26_PERSON_CHANNEL', 'an agent shell in the main checkout cannot accept a check');
  const remote = refusal(await local(box, box.repo, ['check', 'accept', id, '--json'], undefined, { env: { ...env, SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' } }), 'remote shell');
  assert.equal(remote.code, 'B26_PERSON_CHANNEL', 'a remote shell cannot accept a check');
  const worktree = refusal(await local(box, box.web, ['check', 'accept', id, '--json'], undefined, { env }), 'worktree');
  assert.equal(worktree.code, 'B26_PERSON_APPROVAL', 'an agent worktree cannot accept a check, even from a clean terminal');
  const api = apiMove(box, { verb: 'check-accept', item: item.item_id }, 'api', env);
  assert.equal(api.status, 409, JSON.stringify(api));
  assert.equal(api.body.error.code, 'B26_PERSON_CHANNEL', 'the agent API is not the person channel');
  assert.throws(() => refusePersonMove('check_accept'), { code: 'HUMAN_REQUIRED' }, 'MCP refuses a check acceptance as a person move');
  const digest = checkDigest(green);
  const move = withBoard(file, (board) => prepareEngineMove(board, 'acceptCheck', [item.item_id, { agentId: 'person', channel: 'terminal', digest }], { id: 'agent-relay-accept' }));
  assert.equal(CHECK_ACCEPT_ENGINE, 24, 'the released check-acceptance minimum stays engine 24');
  assert.equal(move.engine, ENGINE_VERSION, 'a new envelope declares the current engine independently of its minimum');
  assert.equal(relaySenderProblem(move, { kind: 'agent', userId: 'user-1', agent: 'web-1' }, 'move')?.code, 'RELAY_PERSON_ONLY', 'the relay refuses an agent sending the person’s acceptance');
  withBoard(file, (board) => {
    assert.throws(() => acceptCheck(board, item.item_id, { agentId: 'web-1', channel: 'terminal', digest }), { code: 'CHECK_ACCEPT_PERSON_ONLY' });
    assert.throws(() => applyEngineMove(board, { ...move, engine: CHECK_ACCEPT_ENGINE - 1 }, { sequence: 1, at: '2026-10-17T00:00:00.000Z' }), { code: 'RELAY_MOVE' },
      'an engine older than the acceptance refuses the move before changing anything');
    assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind = 'check_accept'").get().n, 0, 'no refused path recorded an acceptance');
  });
  assert.equal(refusal(await local(box, box.web, ['claim', id, '--json']), 'claim after refusals').code, 'CRITERION_PROVES_NOTHING');
  for (const route of [['next'], ['next', '--build']]) {
    const routed = refusal(await local(box, box.web, [...route, '--json']), route.join(' '));
    assert.equal(routed.code, 'CRITERION_PROVES_NOTHING', `${route.join(' ')} is refused like claim`);
    assert.ok(routed.message.includes(green), `${route.join(' ')} names the check: ${routed.message}`);
  }
  const claims = () => withBoard(file, (board) => board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind = 'claim' AND item_id = ?").get(item.item_id).n);
  assert.equal(claims(), 0, 'no refused route recorded a claim');
  assert.equal(showItem(box, id).item.item_status, 'open');

  const accepted = await local(box, box.repo, ['check', 'accept', id, '--json'], undefined, { env });
  assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
  assert.deepEqual(JSON.parse(accepted.stdout).digest, digest, 'the acceptance binds to the exact check text');
  const claimed = await local(box, box.web, ['next', '--build', '--json']);
  assert.equal(claimed.status, 0, `the person's acceptance lifts the hold for next --build: ${claimed.stdout}${claimed.stderr}`);
  let acceptedClaim = showItem(box, id).item;
  assert.equal(acceptedClaim.item_owner, 'web-1', 'next --build claimed the accepted item');

  /** A native correction is already frozen and retains the claim while the check's hold is evaluated. */
  function assertFrozenCorrection(result, check) {
    const item = JSON.parse(result.stdout).item;
    assert.equal(item.item_status, 'claimed', 'atomic correction retains the live claim');
    assert.equal(item.item_owner, acceptedClaim.item_owner, 'atomic correction retains the holder');
    assert.equal(item.item_lease_until, acceptedClaim.item_lease_until, 'atomic correction retains the lease');
    const frozen = JSON.parse(item.item_frozen);
    assert.equal(frozen.sourceCheck ?? frozen.check, check, 'the correction already freezes the exact new check');
  }

  const changed = fileCheck('green', 'changed-check-marker.txt');
  const edited = await local(box, box.repo, ['edit', id, '--check', changed, '--reason', 'the fixture changes the check', '--wait', '--json'], undefined, { env });
  assert.equal(edited.status, 0, `${edited.stdout}${edited.stderr}`);
  assert.equal(JSON.parse(edited.stdout).item.item_check_baseline.result, 'green', 'the changed check gets a new baseline');
  assertFrozenCorrection(edited, changed);
  commitIn(box, box.web, 'done', 'test: change the held fixture');
  const resubmitted = refusal(await local(box, box.web, ['submit', id, '--json']), 'submit after a changed check');
  assert.equal(resubmitted.code, 'CRITERION_PROVES_NOTHING', 'a changed check needs a new acceptance: submit is refused');
  assert.ok(resubmitted.message.includes(changed), `the submit refusal names the changed check: ${resubmitted.message}`);
  // Submit may renew the claim even when the check hold refuses it.
  acceptedClaim = showItem(box, id).item;

  const red = fileCheck('done', 'red-check-marker.txt');
  const corrected = await local(box, box.repo, ['edit', id, '--check', red, '--reason', 'the old check already passed on main', '--wait', '--json'], undefined, { env });
  assert.equal(corrected.status, 0, `${corrected.stdout}${corrected.stderr}`);
  assert.equal(JSON.parse(corrected.stdout).item.item_check_baseline.result, 'red');
  assertFrozenCorrection(corrected, red);
  const submitted = await local(box, box.web, ['submit', id, '--json']);
  assert.equal(submitted.status, 0, `a red new baseline lifts the hold: ${submitted.stdout}${submitted.stderr}`);

  const second = addChecked(box, 'Second held green check', fileCheck('green', 'second-check-marker.txt')).item;
  const nextHeld = refusal(await local(box, box.web, ['next', '--json']), 'next on a second held item');
  assert.equal(nextHeld.code, 'CRITERION_PROVES_NOTHING', 'next refuses the second held item');
  const reset = await local(box, box.repo, ['edit', String(second.item_id), '--check', fileCheck('done', 'second-red-marker.txt'), '--wait', '--json'], undefined, { env });
  assert.equal(reset.status, 0, `${reset.stdout}${reset.stderr}`);
  assert.equal(JSON.parse(reset.stdout).item.item_check_baseline.result, 'red');
  const nextClaimed = await local(box, box.web, ['next', '--json']);
  assert.equal(nextClaimed.status, 0, `a changed check with a red baseline lifts the hold for next: ${nextClaimed.stdout}${nextClaimed.stderr}`);
  assert.equal(showItem(box, second.item_id).item.item_status, 'claimed', 'next claimed the item once its check was red on main');

  const plain = project({ content: 'green', worktrees: true });
  const { result: warned, item: open } = addChecked(plain, 'Unheld green check', fileCheck('green', 'plain-check-marker.txt'));
  assert.match(warned.stdout, /CRITERION_PROVES_NOTHING/u, 'a board with no setting keeps today’s warning');
  const plainClaim = plain.run(plain.web, ['claim', String(open.item_id), '--json']);
  assert.equal(plainClaim.status, 0, `a board with no setting claims the green check: ${plainClaim.stdout}${plainClaim.stderr}`);
  writeFileSync(join(plain.web, 'web', 'proof.txt'), 'submitted\n');
  plain.git(plain.web, 'add', 'web/proof.txt');
  plain.git(plain.web, 'commit', '-q', '-m', 'test: submit the unheld fixture');
  const plainSubmit = plain.run(plain.web, ['submit', String(open.item_id), '--json']);
  assert.equal(plainSubmit.status, 0, `a board with no setting submits the green check: ${plainSubmit.stdout}${plainSubmit.stderr}`);
});

/**
 * Every fixture join in the check-baseline and check-timing-admission files names a model, so none stops at MODEL_REQUIRED [C7].
 */
test('clause 1: every pullboard join in check-baseline and check-timing-admission passes --model [C7]', () => {
  for (const file of ['../../tests/fixtures/check-baseline.js', '../check/admission.test.js']) {
    const source = readFileSync(resolve(import.meta.dirname, file), 'utf8');
    const joins = source.split('\n').filter(line => /'join'\s*,|fixtureJoin\(/.test(line) && !line.includes("test('"));
    assert.ok(joins.length >= 1, `${file} joins at least once`);
    for (const line of joins) assert.ok(line.includes('--model'), `${file}: ${line.trim()}`);
  }
});

/**
 * A joined fixture worktree exits 0 once --model is passed, so the cases behind it reach their assertions [C7].
 */
test('clause 2: a fixture join with --model succeeds so the cases reach their unchanged assertions [C7]', () => {
  const box = project({ worktrees: true });
  assert.ok(existsSync(box.web) && existsSync(box.review));
});
