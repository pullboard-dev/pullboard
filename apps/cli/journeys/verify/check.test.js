/** The frozen check outcome travels with accepts without changing the board schema [V19,V8]. */
import assert from 'node:assert/strict';
import { AGENT_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { SSH_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import {
  runFixtureExecFile as execFileSync,
  runFixtureChild,
  runFixtureChildAsync,
  runFixtureGit,
  safeFixtureDiagnostic,
} from "../../tests/fixtures/child.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import * as store from "../../../../packages/store/src/io/board.js";
import { openCellBoard as openBoard } from "../../../../packages/store/tests/fixtures/cell.js";
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/e2e.js';

const BIN = resolve(import.meta.dirname, "../../pullboard.js");
const SPEC = '# Fixture\n\n## G · Goals\n- G1 [approved, must] The fixture item is complete. | gate: none\n';

/** Create a private CLI environment with isolated Git, home and board state. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-verdict-check-'));
  const shimDir = join(dir, 'bin');
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shimDir, 'pullboard'), 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, {
    PATH: `${shimDir}:${process.env.PATH}`,
    HOME: join(dir, 'home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture agent',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture agent',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MODEL: 'claude-opus-fixture', // join refuses a session that has not declared its model (MODEL_REQUIRED).
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  });
  delete env.NODE_TEST_CONTEXT; // A fixture CLI/compiler child is a normal process, not its parent's Node test worker.
  // The fixture acts as the person's own terminal: an inherited agent or SSH session would make its verdicts self-verification.
  for (const marker of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[marker];
  mkdirSync(env.HOME);
  // This journey holds its gate in the submitting process, so it pins controller dispatch and the default may move to pull [P7].
  mkdirSync(env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'controller' } });
  /** Run isolated Git commands for this fixture. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  /** Run the checked-out CLI without invoking any shared board. */
  const run = async (cwd, ...args) => {
    const result = await runCliInProcess(args, { cwd, env });
    return { code: result.status, out: result.stdout, err: result.failure ?? result.stderr, failure: result.failure };
  };
  /** Process-level by nature: submit hands its gate to a detached child that outlives the call, which in-process dispatch cannot reproduce. */
  const spawn = (cwd, ...args) => {
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout, err: result.failure ?? result.stderr, failure: result.failure };
  };
  return { dir, env, git, run, spawn };
}

/** Initialize a real board repository and one joined builder worktree. */
async function project(box) {
  const repo = join(box.dir, 'repo');
  const web = join(box.dir, 'web-1');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  // The spec is in place before init, so the board's approval baseline holds its approved rows as the person's (#960).
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  assert.equal((await box.run(repo, 'init')).code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({
    gate: 'test ! -f RED', spec: 'SPEC.md', verify: { policy: 'any', family: 'off' },
    lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G'] }, review: { owns: [], specs: [] } }, shared: [],
  }, null, 2) + '\n');
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: initialize fixture');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  box.env.PULLBOARD_MODEL ||= 'Fixture builder';
  assert.match((await fixtureJoin(box.run, web, 'web')).out, /joined as web-1/);
  return { repo, web };
}

/** Run a fixture command and fail with its captured diagnostics if it refuses. */
async function succeeds(box, cwd, ...args) {
  const result = await box.run(cwd, ...args);
  assert.equal(result.code, 0, result.failure ? `${result.failure}\nstdout:\n${safeFixtureDiagnostic(result.out, box.env)}` : `${result.out}\n${result.err}`);
  return result.out;
}

/** Add, claim, commit and submit one real worktree item with its optional frozen check. */
async function submitted(box, repo, web, title, check) {
  const args = ['add', 'web', title, '--specs', 'G1', '--criterion', 'The fixture item is complete.', '--route', 'strong', '--brief', 'Files: web/fixture.txt\nTest: the fixture item is accepted with its recorded check'];
  if (check) args.push('--check', check);
  const added = await succeeds(box, repo, ...args);
  const id = Number(/#(\d+)/.exec(added)?.[1]);
  assert.ok(id > 0, added);
  await succeeds(box, web, 'claim', String(id));
  mkdirSync(join(web, 'web'), { recursive: true });
  writeFileSync(join(web, 'web', `item-${id}.js`), 'export const complete = true;\n');
  box.git(web, 'add', '-A');
  box.git(web, 'commit', '-q', '-m', `feat(web): complete fixture ${id} [G1]`);
  await succeeds(box, web, 'submit', String(id));
  box.git(repo, 'switch', '--detach', 'web/one');
  return { id, commit: box.git(web, 'rev-parse', 'HEAD') };
}

/** Remove all files created by a test's private repository and SQLite board. */
function clean(box) {
  rmSync(box.dir, { recursive: true, force: true });
}

test('accept records none or green in its event and JSON, and says when unchecked [V19,V8]', async () => {
  const box = sandbox();
  try {
    const { repo, web } = await project(box);
    const unchecked = await submitted(box, repo, web, 'Unchecked accept');
    const noCheck = await succeeds(box, repo, 'verify', String(unchecked.id), 'accept', '--as', 'coordinator', '--note', 'checked the submitted work');
    assert.match(noCheck, /no frozen check ran/);
    const uncheckedEvent = JSON.parse(await succeeds(box, repo, 'log', String(unchecked.id), '--json')).events.find((event) => event.event_kind === 'accept');
    assert.equal(JSON.parse(uncheckedEvent.event_detail).check, 'none');
    const uncheckedShow = JSON.parse(await succeeds(box, repo, 'show', String(unchecked.id), '--json'));
    assert.equal(uncheckedShow.verdicts.at(-1).check, 'none');
    assert.match(await succeeds(box, repo, 'show', String(unchecked.id)), /check: none/);
    box.git(repo, 'switch', 'main');

    const uncheckedJson = JSON.parse(await succeeds(box, repo, 'verify', String((await submitted(box, repo, web, 'Unchecked JSON accept')).id), 'accept', '--as', 'coordinator', '--note', 'checked the submitted work', '--json'));
    assert.equal(uncheckedJson.check, 'none');
    box.git(repo, 'switch', 'main');

    const checked = await submitted(box, repo, web, 'Checked accept', 'node --check web/item-3.js');
    await succeeds(box, repo, 'check', String(checked.id), '--yes'); // Diagnostics must not block an existing frozen check while main is detached for review.
    const checkedSource = join(repo, 'web', `item-${checked.id}.js`);
    const originalSource = readFileSync(checkedSource, 'utf8');
    writeFileSync(checkedSource, 'const = ;\n'); // Keep the negative compiler case unambiguous; Node22 can silently accept invalid detected-ESM .js (#65202).
    // Process-level by nature: this is the Node compiler itself, not the CLI, so no in-process form exists.
    const reference = runFixtureChild(process.execPath, ['--check', checkedSource], { cwd: repo, env: box.env, encoding: 'utf8' });
    assert.equal(reference.status, 1, safeFixtureDiagnostic(JSON.stringify({ phase: 'direct compiler reference', status: reference.status,
      stdout: reference.stdout, stderr: reference.stderr, source: readFileSync(checkedSource, 'utf8'), inheritedTestContext: Boolean(box.env.NODE_TEST_CONTEXT) }), box.env));
    const redCheck = await box.run(repo, 'check', String(checked.id), '--yes', '--json');
    assert.equal(redCheck.code, 1, safeFixtureDiagnostic(JSON.stringify({ phase: 'real check after direct compiler red', redCheck, source: readFileSync(checkedSource, 'utf8') }), box.env));
    assert.equal(JSON.parse(redCheck.out).green, false);
    assert.match(redCheck.err, /failure diagnostics could not finish \(NO_POLICY\).*original result stays red/u);
    writeFileSync(checkedSource, originalSource);
    const checkedJson = JSON.parse(await succeeds(box, repo, 'verify', String(checked.id), 'accept', '--as', 'coordinator', '--note', 'the frozen check passed', '--json'));
    assert.equal(checkedJson.check, 'green');
    const checkedEvent = JSON.parse(await succeeds(box, repo, 'log', String(checked.id), '--json')).events.find((event) => event.event_kind === 'accept');
    assert.equal(JSON.parse(checkedEvent.event_detail).check, 'green');
    const checkedShow = JSON.parse(await succeeds(box, repo, 'show', String(checked.id), '--json'));
    assert.equal(checkedShow.verdicts.at(-1).check, 'green');
    assert.match(await succeeds(box, repo, 'show', String(checked.id)), /check: green/);
  } finally { clean(box); }
});

test('rework keeps historical rejection unknown and shows the latest accept check [V19,V8]', async () => {
  const box = sandbox();
  try {
    const { repo, web } = await project(box);
    const item = await submitted(box, repo, web, 'Reworked accept');
    await succeeds(box, repo, 'verify', String(item.id), 'reject', '--as', 'coordinator', '--reason', 'BEHAVIOR_MISMATCH', '--clause', 'The fixture item is complete.', '--note', 'the first version missed an edge');
    box.git(repo, 'switch', 'main');
    await succeeds(box, web, 'claim', String(item.id));
    writeFileSync(join(web, 'web', `item-${item.id}.js`), 'export const complete = true; // revised\n');
    box.git(web, 'add', '-A');
    box.git(web, 'commit', '-q', '-m', `fix(web): correct fixture ${item.id} [G1]`);
    await succeeds(box, web, 'submit', String(item.id));
    box.git(repo, 'switch', '--detach', 'web/one');
    const accepted = await succeeds(box, repo, 'verify', String(item.id), 'accept', '--as', 'coordinator', '--note', 'the rework fixed the missed edge');
    assert.match(accepted, /no frozen check ran/);
    const shownJson = JSON.parse(await succeeds(box, repo, 'show', String(item.id), '--json'));
    assert.deepEqual(shownJson.verdicts.map((verdict) => verdict.check), ['unknown', 'none']);
    const shown = (await succeeds(box, repo, 'show', String(item.id))).split('\n');
    const rejectLine = shown.findIndex((line) => line.startsWith('REJECT BEHAVIOR_MISMATCH'));
    const acceptLine = shown.findIndex((line) => line.startsWith('ACCEPT CRITERION_MET'));
    assert.ok(rejectLine >= 0 && acceptLine > rejectLine);
    assert.equal(shown[rejectLine + 1], '  check: unknown');
    assert.equal(shown[acceptLine + 1], '  check: none');
    const rows = (await succeeds(box, repo, 'ledger')).split('\n').filter((line) => line.startsWith(`| ${item.id} |`));
    assert.equal(rows.length, 1);
    assert.match(rows[0], /\| unchecked \|/);
    assert.equal(rows[0].split('|')[7].trim(), 'unchecked', 'the check column describes the latest accept');
  } finally { clean(box); }
});

test('historical accepts read unknown in show and unchecked accepts are marked in ledger [V19,V8]', async () => {
  const box = sandbox();
  try {
    const { repo, web } = await project(box);
    const historical = await submitted(box, repo, web, 'Historical accept');
    const common = box.git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    // @pullboard-board-file journey: read verdicts from the board file the real CLI wrote
    const board = openBoard(join(common, 'pullboard', 'board.sqlite'));
    try {
      const item = store.getItem(board, historical.id);
      store.verify(board, historical.id, {
        agentId: 'coordinator', decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'legacy event fixture',
        head: historical.commit, digest: item.item_frozen_digest, policy: 'any', familyPolicy: 'off',
      });
    } finally { store.closeBoard(board); }
    const shown = await succeeds(box, repo, 'show', String(historical.id));
    assert.match(shown, /check: unknown/);
    box.git(repo, 'switch', 'main');
    const unchecked = await submitted(box, repo, web, 'Unchecked ledger row');
    await succeeds(box, repo, 'verify', String(unchecked.id), 'accept', '--as', 'coordinator', '--note', 'fixture accept without a frozen check');
    assert.match(await succeeds(box, repo, 'ledger'), new RegExp(`\\| ${unchecked.id} \\|[^\\n]*\\| unchecked \\|`));
  } finally { clean(box); }
});

/** Read the verdicts of one item from the repo's board, opening it read-only for the assertion. */
function verdictsOf(repo, id) {
  // @pullboard-board-file journey: read verdicts from the board file the real CLI wrote
  const board = openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  try { return store.verdictsFor(board, id); }
  finally { store.closeBoard(board); }
}

/** Poll until a condition holds, failing with what the test was waiting for. */
async function until(condition, what, timeoutMs = 20_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('a landing while a review waits for its gate slot leaves the verdict standing [V8,Q4]', async (t) => {
  // With verify.composeAtAdmission on, verify composes against main once the gate admits it (#929). A landing
  // while the review waits in the queue must not void it; the verdict records the main it judged.
  const box = sandbox();
  t.after(() => clean(box));
  const { repo, web } = await project(box);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ ...config, verify: { ...config.verify, composeAtAdmission: true } }, null, 2) + '\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: verify composes at admission');
  box.git(web, 'merge', '-q', 'main');
  await succeeds(box, repo, 'settings', 'gateSlots', '1');
  const { id, commit } = await submitted(box, repo, web, 'Queued review', 'true');
  const reviewer = join(box.dir, 'queued-reviewer');
  box.git(repo, 'worktree', 'add', '-q', '--detach', reviewer, commit);
  await succeeds(box, reviewer, 'join', 'web');
  // A second repo holds the machine's only gate slot until its flag file says it has started.
  const holder = join(box.dir, 'holder');
  mkdirSync(holder);
  box.git(holder, 'init', '-q', '-b', 'main');
  assert.equal((await box.run(holder, 'init')).code, 0);
  const flag = join(box.dir, 'holder-started');
  writeFileSync(join(holder, 'hold.js'), `require('fs').writeFileSync(${JSON.stringify(flag)}, '1'); setTimeout(() => {}, 4000);\n`);
  const holderConfig = JSON.parse(readFileSync(join(holder, 'pullboard.json'), 'utf8'));
  writeFileSync(join(holder, 'pullboard.json'), JSON.stringify({ ...holderConfig, gate: 'node hold.js' }, null, 2) + '\n');
  box.git(holder, 'add', '-A');
  box.git(holder, 'commit', '-q', '-m', 'chore: holder');
  // Process-level by nature (2 launches below): the holder and the queued review must run concurrently as other processes
  // contending for the one gate slot, which serialized in-process dispatch cannot do.
  const holding = runFixtureChildAsync(process.execPath, [BIN, 'gate'], { cwd: holder, env: box.env, encoding: 'utf8' });
  await until(() => existsSync(flag), 'the holder to own the only gate slot');
  const verifying = runFixtureChildAsync(process.execPath, [BIN, 'verify', String(id), 'accept', '--note', 'Verified while queued'], {
    cwd: reviewer, env: box.env, encoding: 'utf8',
  });
  // The holder's check runs for four seconds; the review queues behind it. Land while both are still pending.
  let holderSettled = false;
  holding.then(() => { holderSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(holderSettled, false, 'the holder still owns the only slot when main moves');
  box.git(repo, 'switch', '-q', 'main');
  writeFileSync(join(repo, 'landed-while-queued.txt'), 'landed\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'feat: land while the review queues [G1]');
  const held = await holding;
  assert.equal(held.status, 0, held.failure ?? held.stderr);
  const verified = await verifying;
  assert.equal(verified.status, 0, verified.failure ?? `${verified.stdout}${verified.stderr}`);
  const verdicts = verdictsOf(repo, id);
  assert.equal(verdicts.length, 1, 'the verdict stands after the landing');
  assert.equal(verdicts[0].verdict_decision, 'ACCEPT');
});

test('a landing during the check itself still refuses the verdict [V8]', async (t) => {
  // With verify.composeAtAdmission on, a main that moves while the frozen check runs still voids the verdict (#929).
  const box = sandbox();
  t.after(() => clean(box));
  const { repo, web } = await project(box);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ ...config, verify: { ...config.verify, composeAtAdmission: true } }, null, 2) + '\n');
  mkdirSync(join(repo, 'web'), { recursive: true });
  writeFileSync(join(repo, 'web', 'review-input.txt'), 'before submit\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: verify composes at admission');
  box.git(web, 'merge', '-q', 'main');
  // The landing changes the item's own file with the bytes it reviewed (so the composition merges cleanly), and only once the review checkout exists (an earlier empty landing keeps the submit proof from being reused): an empty or unrelated landing no longer voids a verdict (61b93a7c77).
  const reviewer = join(box.dir, 'moving-check-reviewer');
  const landing = `test -f web/review-input.txt && { [ -d '${reviewer}' ] || { git -C '${repo}' -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -q -m 'feat: land before the review [G1]'; exit 0; }; mkdir -p '${repo}/web' && printf 'export const complete = true;\\n' > '${repo}/web/item-1.js' && git -C '${repo}' add web/item-1.js && git -C '${repo}' -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -q -m 'feat: land during the check [G1]'; }`;
  const { id, commit } = await submitted(box, repo, web, 'Moving check', landing);
  box.git(repo, 'switch', '-q', 'main');
  writeFileSync(join(repo, 'web', 'review-input.txt'), 'after submit\n');
  box.git(repo, 'add', 'web/review-input.txt');
  box.git(repo, 'commit', '-q', '-m', 'chore: change the checked review input');
  box.git(repo, 'worktree', 'add', '-q', '--detach', reviewer, commit);
  await succeeds(box, reviewer, 'join', 'web');
  const refused = await box.run(reviewer, 'verify', String(id), 'accept', '--note', 'Verified while main moves during the check');
  assert.equal(refused.code, 1, refused.out + refused.err);
  assert.match(refused.err, /VERDICT_TRUNK_MOVED/u);
  assert.deepEqual(verdictsOf(repo, id), [], 'a verdict is not recorded for a check that saw a moved main');
});

for (const on of [false, true]) test(`review.excludeEarlierHolders ${on ? 'on refuses' : 'off allows'} a seat that claimed then released the item to reserve its review [V1,B3]`, async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const ok = result => { assert.equal(result.code, 0, result.err || result.out); return JSON.parse(result.out); };
  const early = join(box.dir, 'early-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', early, 'main');
  ok(await box.inProcess(early, 'join', 'web', '--model', FIXTURE_MODEL, '--route', 'strong', '--json'));
  ok(await fixtureAdd(box.inProcess, box.repo, 'web', 'Held before', '--criterion', 'the feature builds', '--specs', 'G1', '--check', 'true', '--json'));
  ok(await box.inProcess(early, 'claim', '1', '--json'));
  ok(await box.inProcess(early, 'release', '1', '--reason', 'OTHER', '--note', 'dropped before building', '--json'));
  ok(await box.inProcess(box.web, 'claim', '1', '--json'));
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.js', 'built\n', 'feat(web): build feature [G1]').status, 0);
  ok(await box.inProcess(box.web, 'submit', '1', '--json'));
  if (on) {
    const file = join(early, 'pullboard.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), review: { excludeEarlierHolders: true } }, null, 2) + '\n');
    box.git(early, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qam', 'chore: exclude earlier holders from review');
  }
  const reserve = await box.inProcess(early, 'next', '--verify', '1', '--json');
  if (on) {
    assert.equal(reserve.code, 1, reserve.out + reserve.err);
    assert.equal(JSON.parse(reserve.out).error.code, 'REVIEW_EARLIER_HOLDER');
    assert.match(JSON.parse(reserve.out).error.message, /review\.excludeEarlierHolders/u);
  } else assert.equal(reserve.code, 0, `off: only the builder is excluded\n${reserve.out}${reserve.err}`);
});
