/** @pullboard-test-input apps/cli/pullboard.js packages/codemap/data/plan/path-map/store.json packages/store/index.js packages/store/src/io/board/capture.js packages/store/src/io/board/ports.js packages/store/src/io/receipts.js packages/store/src/logic/board/receipts.js packages/store/src/logic/known/main/reworks.js */
/** The frozen check outcome travels with accepts without changing the board schema [V19,V8]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lex } from '../../../../packages/kernel/index.js';
import { AGENT_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { SSH_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { styleSources } from '../../../../packages/codemap/index.js';
import { readEngineLeaves } from '../../../../packages/state/src/io/engine/numbers.js';
import { gateJudgmentPath } from '../../../../packages/verify/index.js';
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
  posix,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import * as store from "../../../../packages/store/src/io/board.js";
import { openCellBoard as openBoard } from "../../../../packages/store/tests/fixtures/cell.js";
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

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
  /** Run isolated Git commands for this fixture. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  /** Run the checked-out CLI without invoking any shared board. */
  const run = (cwd, ...args) => {
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout, err: result.failure ?? result.stderr, failure: result.failure };
  };
  return { dir, env, git, run };
}

/** Initialize a real board repository and one joined builder worktree. */
function project(box) {
  const repo = join(box.dir, 'repo');
  const web = join(box.dir, 'web-1');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  // The spec is in place before init, so the board's approval baseline holds its approved rows as the person's (#960).
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  assert.equal(box.run(repo, 'init').code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({
    gate: 'test ! -f RED', spec: 'SPEC.md', verify: { policy: 'any', family: 'off' },
    lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G'] }, review: { owns: [], specs: [] } }, shared: [],
  }, null, 2) + '\n');
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: initialize fixture');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  box.env.PULLBOARD_MODEL ||= 'Fixture builder';
  assert.match(fixtureJoin(box.run, web, 'web').out, /joined as web-1/);
  return { repo, web };
}

/** Run a fixture command and fail with its captured diagnostics if it refuses. */
function succeeds(box, cwd, ...args) {
  const result = box.run(cwd, ...args);
  assert.equal(result.code, 0, result.failure ? `${result.failure}\nstdout:\n${safeFixtureDiagnostic(result.out, box.env)}` : `${result.out}\n${result.err}`);
  return result.out;
}

/** Add, claim, commit and submit one real worktree item with its optional frozen check. */
function submitted(box, repo, web, title, check) {
  const args = ['add', 'web', title, '--specs', 'G1', '--criterion', 'The fixture item is complete.', '--route', 'strong', '--brief', 'Files: web/fixture.txt\nTest: the fixture item is accepted with its recorded check'];
  if (check) args.push('--check', check);
  const added = succeeds(box, repo, ...args);
  const id = Number(/#(\d+)/.exec(added)?.[1]);
  assert.ok(id > 0, added);
  succeeds(box, web, 'claim', String(id));
  mkdirSync(join(web, 'web'), { recursive: true });
  writeFileSync(join(web, 'web', `item-${id}.js`), 'export const complete = true;\n');
  box.git(web, 'add', '-A');
  box.git(web, 'commit', '-q', '-m', `feat(web): complete fixture ${id} [G1]`);
  succeeds(box, web, 'submit', String(id));
  box.git(repo, 'switch', '--detach', 'web/one');
  return { id, commit: box.git(web, 'rev-parse', 'HEAD') };
}

/** Remove all files created by a test's private repository and SQLite board. */
function clean(box) {
  rmSync(box.dir, { recursive: true, force: true });
}

test('accept records none or green in its event and JSON, and says when unchecked [V19,V8]', () => {
  const box = sandbox();
  try {
    const { repo, web } = project(box);
    const unchecked = submitted(box, repo, web, 'Unchecked accept');
    const noCheck = succeeds(box, repo, 'verify', String(unchecked.id), 'accept', '--as', 'coordinator', '--note', 'checked the submitted work');
    assert.match(noCheck, /no frozen check ran/);
    const uncheckedEvent = JSON.parse(succeeds(box, repo, 'log', String(unchecked.id), '--json')).events.find((event) => event.event_kind === 'accept');
    assert.equal(JSON.parse(uncheckedEvent.event_detail).check, 'none');
    const uncheckedShow = JSON.parse(succeeds(box, repo, 'show', String(unchecked.id), '--json'));
    assert.equal(uncheckedShow.verdicts.at(-1).check, 'none');
    assert.match(succeeds(box, repo, 'show', String(unchecked.id)), /check: none/);
    box.git(repo, 'switch', 'main');

    const uncheckedJson = JSON.parse(succeeds(box, repo, 'verify', String((submitted(box, repo, web, 'Unchecked JSON accept')).id), 'accept', '--as', 'coordinator', '--note', 'checked the submitted work', '--json'));
    assert.equal(uncheckedJson.check, 'none');
    box.git(repo, 'switch', 'main');

    const checked = submitted(box, repo, web, 'Checked accept', 'node --check web/item-3.js');
    succeeds(box, repo, 'check', String(checked.id), '--yes'); // Diagnostics must not block an existing frozen check while main is detached for review.
    const checkedSource = join(repo, 'web', `item-${checked.id}.js`);
    const originalSource = readFileSync(checkedSource, 'utf8');
    writeFileSync(checkedSource, 'const = ;\n'); // Keep the negative compiler case unambiguous; Node22 can silently accept invalid detected-ESM .js (#65202).
    const reference = runFixtureChild(process.execPath, ['--check', checkedSource], { cwd: repo, env: box.env, encoding: 'utf8' });
    assert.equal(reference.status, 1, safeFixtureDiagnostic(JSON.stringify({ phase: 'direct compiler reference', status: reference.status,
      stdout: reference.stdout, stderr: reference.stderr, source: readFileSync(checkedSource, 'utf8'), inheritedTestContext: Boolean(box.env.NODE_TEST_CONTEXT) }), box.env));
    const redCheck = box.run(repo, 'check', String(checked.id), '--yes', '--json');
    assert.equal(redCheck.code, 1, safeFixtureDiagnostic(JSON.stringify({ phase: 'real check after direct compiler red', redCheck, source: readFileSync(checkedSource, 'utf8') }), box.env));
    assert.equal(JSON.parse(redCheck.out).green, false);
    assert.match(redCheck.err, /failure diagnostics could not finish \(NO_POLICY\).*original result stays red/u);
    writeFileSync(checkedSource, originalSource);
    const checkedJson = JSON.parse(succeeds(box, repo, 'verify', String(checked.id), 'accept', '--as', 'coordinator', '--note', 'the frozen check passed', '--json'));
    assert.equal(checkedJson.check, 'green');
    const checkedEvent = JSON.parse(succeeds(box, repo, 'log', String(checked.id), '--json')).events.find((event) => event.event_kind === 'accept');
    assert.equal(JSON.parse(checkedEvent.event_detail).check, 'green');
    const checkedShow = JSON.parse(succeeds(box, repo, 'show', String(checked.id), '--json'));
    assert.equal(checkedShow.verdicts.at(-1).check, 'green');
    assert.match(succeeds(box, repo, 'show', String(checked.id)), /check: green/);
  } finally { clean(box); }
});

test('rework keeps historical rejection unknown and shows the latest accept check [V19,V8]', () => {
  const box = sandbox();
  try {
    const { repo, web } = project(box);
    const item = submitted(box, repo, web, 'Reworked accept');
    succeeds(box, repo, 'verify', String(item.id), 'reject', '--as', 'coordinator', '--reason', 'BEHAVIOR_MISMATCH', '--clause', 'The fixture item is complete.', '--note', 'the first version missed an edge');
    box.git(repo, 'switch', 'main');
    succeeds(box, web, 'claim', String(item.id));
    writeFileSync(join(web, 'web', `item-${item.id}.js`), 'export const complete = true; // revised\n');
    box.git(web, 'add', '-A');
    box.git(web, 'commit', '-q', '-m', `fix(web): correct fixture ${item.id} [G1]`);
    succeeds(box, web, 'submit', String(item.id));
    box.git(repo, 'switch', '--detach', 'web/one');
    const accepted = succeeds(box, repo, 'verify', String(item.id), 'accept', '--as', 'coordinator', '--note', 'the rework fixed the missed edge');
    assert.match(accepted, /no frozen check ran/);
    const shownJson = JSON.parse(succeeds(box, repo, 'show', String(item.id), '--json'));
    assert.deepEqual(shownJson.verdicts.map((verdict) => verdict.check), ['unknown', 'none']);
    const shown = succeeds(box, repo, 'show', String(item.id)).split('\n');
    const rejectLine = shown.findIndex((line) => line.startsWith('REJECT BEHAVIOR_MISMATCH'));
    const acceptLine = shown.findIndex((line) => line.startsWith('ACCEPT CRITERION_MET'));
    assert.ok(rejectLine >= 0 && acceptLine > rejectLine);
    assert.equal(shown[rejectLine + 1], '  check: unknown');
    assert.equal(shown[acceptLine + 1], '  check: none');
    const rows = succeeds(box, repo, 'ledger').split('\n').filter((line) => line.startsWith(`| ${item.id} |`));
    assert.equal(rows.length, 1);
    assert.match(rows[0], /\| unchecked \|/);
    assert.equal(rows[0].split('|')[7].trim(), 'unchecked', 'the check column describes the latest accept');
  } finally { clean(box); }
});

test('historical accepts read unknown in show and unchecked accepts are marked in ledger [V19,V8]', () => {
  const box = sandbox();
  try {
    const { repo, web } = project(box);
    const historical = submitted(box, repo, web, 'Historical accept');
    const common = box.git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const board = openBoard(join(common, 'pullboard', 'board.sqlite'));
    try {
      const item = store.getItem(board, historical.id);
      store.verify(board, historical.id, {
        agentId: 'coordinator', decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'legacy event fixture',
        head: historical.commit, digest: item.item_frozen_digest, policy: 'any', familyPolicy: 'off',
      });
    } finally { store.closeBoard(board); }
    const shown = succeeds(box, repo, 'show', String(historical.id));
    assert.match(shown, /check: unknown/);
    box.git(repo, 'switch', 'main');
    const unchecked = submitted(box, repo, web, 'Unchecked ledger row');
    succeeds(box, repo, 'verify', String(unchecked.id), 'accept', '--as', 'coordinator', '--note', 'fixture accept without a frozen check');
    assert.match(succeeds(box, repo, 'ledger'), new RegExp(`\\| ${unchecked.id} \\|[^\\n]*\\| unchecked \\|`));
  } finally { clean(box); }
});

/** Read the verdicts of one item from the repo's board, opening it read-only for the assertion. */
function verdictsOf(repo, id) {
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
  const { repo, web } = project(box);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ ...config, verify: { ...config.verify, composeAtAdmission: true } }, null, 2) + '\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: verify composes at admission');
  box.git(web, 'merge', '-q', 'main');
  succeeds(box, repo, 'settings', 'gateSlots', '1');
  const { id, commit } = submitted(box, repo, web, 'Queued review', 'true');
  const reviewer = join(box.dir, 'queued-reviewer');
  box.git(repo, 'worktree', 'add', '-q', '--detach', reviewer, commit);
  succeeds(box, reviewer, 'join', 'web');
  // A second repo holds the machine's only gate slot until its flag file says it has started.
  const holder = join(box.dir, 'holder');
  mkdirSync(holder);
  box.git(holder, 'init', '-q', '-b', 'main');
  assert.equal(box.run(holder, 'init').code, 0);
  const flag = join(box.dir, 'holder-started');
  writeFileSync(join(holder, 'hold.js'), `require('fs').writeFileSync(${JSON.stringify(flag)}, '1'); setTimeout(() => {}, 4000);\n`);
  const holderConfig = JSON.parse(readFileSync(join(holder, 'pullboard.json'), 'utf8'));
  writeFileSync(join(holder, 'pullboard.json'), JSON.stringify({ ...holderConfig, gate: 'node hold.js' }, null, 2) + '\n');
  box.git(holder, 'add', '-A');
  box.git(holder, 'commit', '-q', '-m', 'chore: holder');
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

test('a landing during the check itself still refuses the verdict [V8]', (t) => {
  // With verify.composeAtAdmission on, a main that moves while the frozen check runs still voids the verdict (#929).
  const box = sandbox();
  t.after(() => clean(box));
  const { repo, web } = project(box);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ ...config, verify: { ...config.verify, composeAtAdmission: true } }, null, 2) + '\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: verify composes at admission');
  box.git(web, 'merge', '-q', 'main');
  // The landing changes the item's own file with the bytes it reviewed (so the composition merges cleanly), and only once the review checkout exists (an earlier empty landing keeps the submit proof from being reused): an empty or unrelated landing no longer voids a verdict (61b93a7c77).
  const reviewer = join(box.dir, 'moving-check-reviewer');
  const landing = `[ -d '${reviewer}' ] || { git -C '${repo}' -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -q -m 'feat: land before the review [G1]'; exit 0; }; mkdir -p '${repo}/web' && printf 'export const complete = true;\\n' > '${repo}/web/item-1.js' && git -C '${repo}' add web/item-1.js && git -C '${repo}' -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -q -m 'feat: land during the check [G1]'`;
  const { id, commit } = submitted(box, repo, web, 'Moving check', landing);
  box.git(repo, 'switch', '-q', 'main');
  box.git(repo, 'worktree', 'add', '-q', '--detach', reviewer, commit);
  succeeds(box, reviewer, 'join', 'web');
  const refused = box.run(reviewer, 'verify', String(id), 'accept', '--note', 'Verified while main moves during the check');
  assert.equal(refused.code, 1, refused.out + refused.err);
  assert.match(refused.err, /VERDICT_TRUNK_MOVED/u);
  assert.deepEqual(verdictsOf(repo, id), [], 'a verdict is not recorded for a check that saw a moved main');
});

// Accepted main265b6e8: every store production byte is pinned except relocation operands.
const STORE_BODY_HASHES = {
  "src/exit-rules-continuation.js": "e6ce02be3e201fbf7db44f14e3e7a8a08d21ad6f70a07e8ac1351f719e2d89ed", "src/exit-rules-state.js": "43cff0e1fe6b69e3e06438f9842999ddca53d131e95ba935761bd12755a04e90",
  "src/known-main-autofile.js": "cfcefe647a8590232176ef4bea8a1cc9c59d8070748ec15f2f61e1716cc51c1b", "src/board-access.js": "b5898d8b29808d58563118e90851aaf7fada6b14778d9fde1cc7f97cda2233c8",
  "src/board-busy.js": "46dfa1149b6468c47b3d1b75142495c8532397640cfd64300fc3c19371b444d6", "src/board-capture.js": "3bdf7cfe9c7e7a223c1d2b0e5e1deb89e519fa82c4ceb0d1f513d82076f9f3e3",
  "src/board-event-log-migrate.js": "c7702babc4b01fefdb14c37e4afc9c6229c29dbd995dac7872a7529fb7bf8ae8", "src/board-event-log.js": "871e7170802e5264c21cf080ffe8faced27fd39821efcf08b9929c88751b55ae",
  "src/board-health.js": "59d4611738b111344996f0d09074c702b85bd0332ef451d55e80e5158ccd815a", "src/board-hot.js": "74f05d984278479e92155d8750d071368fd59a1c586bd57f95e833134cc784a7",
  "src/board-inventory.js": "0a6a433174971e2f05795bd6cc47bd3d5b994867a920b12c8e534c26d8686e07", "src/board-item-dependencies.js": "bcd9f96c6da94ad6f80f31cee806c51f727f8b8c4f3333afe9033eabeb6d6d46",
  "src/board-item-read.js": "47b9da4621eb195e39b69be7a1a1517970cf1d1800433373e522a92909d260ae", "src/board-link-envelope.js": "7c19ddd8fd4e44c0b9bb6c5c3a5ed1709b5fdea266973ffe133e86610de17ea3",
  "src/board-link-relay.js": "69c75aa84eca41160794609951941fe41f47b670dd7033c2c8e7ad06276128c6", "src/board-link-ssh.js": "99bb4a0a223d9f40e885b02fa9e9dd6d27cecd77001cd1cf3d55d557c0f7c849",
  "src/board-link-state.js": "9e0f6860c91c40234c52d672f3a4ce32748e8ae50f5906cf17f1dca07977e30b", "src/board-link.js": "40212bdeef409ee18446ba78892327c6294ae565c06863bc7b1be53ff4d89ef7",
  "src/board-members.js": "91278a43b1d3b568d59cc0c450dac6fe069361b08527fca0a8b5cebf72242bbc", "src/board-migrate.js": "e2c668a8a4a61c620932faadf5e78a5afb34147103514a93ec3408587895c504",
  "src/board-query.js": "1b5a5df1062a3ddca0ed54473baa9cf20259327d412c5b731f700171d9044f3a", "src/board-read-auxiliary.js": "a6b0e357b63eb774da5101fc23cad7d2f2f854ab65ed1520247daf9cd6f2c3c3",
  "src/board-read-open.js": "6211c45798871209a093830c49289fff1f72404cda738f01878bf13d568af163", "src/board-rehome.js": "ea3f4a0b7ab9584917f404e072c3b1462b2525b1084487ffaa528bbf0f486a21",
  "src/board-schema-source.js": "41c2ec4afa58d3d813e4fb601ffdc0995d825f0506d507d93845c16ed126c56e", "src/board-schema.js": "9d0e27591f449ed3e4e62bd53a74dd6b49d143eacd99e54abb2a00a8ff9c689e",
  "src/board-signing-recovery.js": "5d29d936067c3514891d4d8bb050124446cd4e62298d5f84e8d86f69bacd6689", "src/board-stats.js": "014368fe201cc4b7679cd10c306a0205b36e8d0d8f49c5c8903f9d6313702a47",
  "src/board-store-guards.js": "59d61adf6f03ffeb7392bcf964889d1db456a5bcf09af0fd44e95ea4ac8d92ac", "src/board-write-lock.js": "814ecb9d465d12d8c611de7b485f5bd9e75cf1c497a5a8eda2363e522cda5686",
  "src/board.js": "abc96858e0e3a62393d87ed46498b21c5ee9e9219b694fa26a6bdb6d11d5984d", "src/companion.js": "f3d829f6e5df7111122fa26736200c03efefad686fc97e9ef9796003914d0fa9",
  "src/dispatch-eligibility.js": "6278fd2c829c9607c975005dad757125de74b4f006a7d40c7fb098f42e77e709", "src/exchange.js": "d03f313dba47adf0d154ed525a0a6e14a87e8c82addf4e7ec1f3ff12ac193f7e",
  "src/history.js": "fa0fd97a765ad359c5965b98d323a99e7d8a50d0905acd58affea61cfb43dad8", "src/item-check-baseline.js": "99c8932745a884b917893567cd2210ae93990dd0e5c744c465113c9d49bb2f7e",
  "src/known-main-reworks.js": "244b98abd3ed373f327f0d1de4147b8579e195c6b04a142616c74b7f179a12e0", "src/local-state.js": "572b942586f48637f2b65f9b36ec22ed42eaa31820624e1ecd636e4184b39f35",
  "src/main-red-build-routing.js": "bf0552511596d606da161da43bac271ae05a2b68786e8d3f82f847c7bf4ea984", "src/memory-held.js": "3ddaf339187426ca0ab5ac0518409853ded5120b7d247b2788f463144c082c70",
  "src/native-board-state.js": "6d39353b6d3b2a273252deee57cc2820246fdefa897fdcbb7b71e0de293817d8", "src/native-state-clock.js": "cf9fb8899caa4cfc789d2ae26d3c538dffbf0d779d731044e7dbeaffe75e3426",
  "src/native-user-directory.js": "94f415cdc875eb6c796ff34ae1b9e5adee2a911d6fac3aebac057103acbac1dc", "src/outside-store.js": "d6267a06e55614b297c7d94439bb9257604fc4de3b677b65dd6dd612766c52db",
  "src/proof-receipts.js": "2064b38ea3a149fa87bd623141f51dca11ce7b04949ec563b13d76b562262781", "src/seat-presence.js": "6406b2968271407b1b55e8a226020bd8a7fdfed22acaff7ac1228e678033f352",
  "src/source-advance-return.js": "dfac69cc31e3c96b5f29137d1dd7d68a1f11d4259ae78365b3507b1d78e2efb1", "src/spec-approval-baseline.js": "fb68798d38de29b29fcbe1b7e38523a57213b3fb91034006ed970cbdb4ccaaa1",
  "src/submission-record.js": "6cc96832fb0413a756a855447494aa4bcf85cbb6270b2099fc59c709e9cbe096", "src/typed-requests.js": "784a50e2b48e860629eca272bcfdea4dda3470a4c35ba33fba34f0920ebf1c90",
  "src/board-engine-ports.js": "583fb8b3e7c8787d1d14bf8e136c8e4c2d48e2158e7659537b567f482b900f1d", "src/board-milestones.js": "07b6e2e6e90ffeaf29ecc17f787eae492ad4a5e15c276520c0b1609f132b3b3b",
  "src/board-store.js": "bb82ba9bd0df38e28874e204a7241f9a57feaadaa8313a8f3dd9fc06689cf800", "src/board-person-authority-schema.js": "3b030720e19347d6fec66f7cb5eb37ca0750de0bb52e62bd3ce18636a422bca6",
  "src/board-activity-delivery-store.js": "37f90352cdb4d75680bfb420b5835d2145c5b022e6ae3c55b6c5d07198bf4166", "src/board-activity-feed.js": "05df3fa1e1e24749f5f396d0929eab71d93ab595f6704347df72655f685697ff",
  "src/board-activity-news.js": "ccdd40c60a9c2aa76d14b97519158acfab1df3f1c6445b533ce43bbf2d68d6f1", "src/board-landing-exceptions.js": "411e1d5aa110c607319baee0079f5df388c56ea9976cafaedc10240ef20f7694",
  "src/board-landing-lease.js": "c08f5daf697ffe09ff8e669aacc0d9ef9106dfefb516400d11b0c8ec515f0875", "src/board-landing-local-lease.js": "98fc3ac1334995717c25db764d3702ca738f0488f9dae578c8abb98b46b4c190",
  "src/board-landing-test-defect-history.js": "f56c3ce729d78945877a6ef51cb97296434a26fbef7eefc2705f3f011b93abf4", "src/board-landing-test-defects.js": "953b5fee424a3f2e8be2167aa0e50b8f2d1e273641ef68908acc034eb5c01b02",
  "src/board-inbox-store.js": "88070aba308b71969958481f931ff28905451ab8f53f8be5879b4e685329e5b1", "src/board-shout-audience.js": "cbee70607b8103c030ae5e3d07c02e9e263c13fa4764b9602a53ac59cb303a94",
  "src/board-worker-inbox.js": "0a348c214458fe057dead9011cdd220412ce97d7116f83f3392d774ead6c978b", "src/board-conditional-holds.js": "43c052922168888a8d7fdd8549ed918da83a97d1d87b3e2750e92848c2d2271d",
  "src/board-health-receipts.js": "22d41f344a1e51410effad4436ac37e082d3215820eac564e4a919be81f6135d", "src/board-recurring-jobs.js": "1b2aa428420e69462a9ebed96e4424c105f64c95777f50848eecbd4c4c2360d2",
  "src/board-release-claim.js": "3e12c1e0fc674939bef2ac213dd5ed7c022b7d912c9a61a08a10a63b4835b550", "src/board-stale-claim-release.js": "601a430bca6c773127dd1620639802c9cbae67b829afdb2fce3d8e0e6d9addb5",
  "src/board-stale-state-maintenance.js": "47185b8d63d7c2e887b4660a144bfa5408279c44d4ede00c144eeb0228ce3468", "src/board-stale-state-policy.js": "cecb5f01efca56d09e11a910520740093e47cdd09ec61f55569cf0cd98dacaab",
  "src/board-stale-state-store.js": "e93c4231e1fee0bb198df1b05f6f90d94472a8afaff7adbf580e228ce82c13ee", "src/board-rigor-auto-source.js": "890678baea24e2161e831e84f00340e538dc5521ad32d5b05ba7b57a8d0c9b34",
  "src/board-rigor-source.js": "33f348cb275d515210e30ca5c0cc18ec79a9809ac0dce9583214357507422d55", "src/board-rigor.js": "f1fd397412327f4145500c1b7d52d928881bbf1dfbd94d0738077fc160a96bce",
  "src/board-claim.js": "2df9dbc461fee31d11c627bcb8d776e9b196c1905ee3d98aa0237b20f8f56ccf", "src/board-command-write.js": "3e65318ec498043e59f2c07d4b55d6ae7a8c7d60e5eb814bbeb75505863a43aa",
  "src/board-write-preparation.js": "41e353a4ac017be9dfe130b35e23d233ff93f7502d896a704c03cb129b5e5ded", "src/board-act-on-activity.js": "d0681f7d6c2ebd281e1a0ebd14251e516607c590713659a04aeb65448c27dc64",
  "src/board-activity-delivery.js": "4af3eb9c0b234e11ece8d5dfa1c4ddd9366a22a09034c51c63a00241ed9bf319", "src/board-add-item.js": "61a986818dafc029f9ba7188b2de12ce83ce8f8377a979602d1a4a35d70df24f",
  "src/board-answer-decision.js": "eac6bdde95d7a34d39627ebfce6a7debfb108d0b62ac37d7b38f09ad72648528", "src/board-append-fact.js": "9acd149cfd1c454eca7dce1efb40a91c340d8a69975a12925b0c5249dae3fb5c",
  "src/board-apply-rehome-item.js": "a83031486d74b46148276c90abc1f90a59b3f0feec20d2ab29db52585bda1ca2", "src/board-apply-row-decisions.js": "a95e1fb9eff936309d9887c8460a89af8d8504c4f4fbcb9ca93edc89e11b5fb0",
  "src/board-approve-outside.js": "b589960d8ab4deed1764dcef47e4e05459fbb689f124b3fdc013a02ce76a05f5", "src/board-attach-item-patch.js": "26a5a1e8bfd13bda2a435eef546191c42100f87b2e9b36f880bf59775dcac4cc",
  "src/board-build-order.js": "e96b273914b50aa562cbd25df95e11d7f91a02c6181652acd5f8323f233eb04e", "src/board-edit-item.js": "fdcf6a22665615a011c1cc9f460d8ee1bf125265f3c02ff70b8adacdf06427c4",
  "src/board-ensure-coordinator.js": "5b24bc6d12347e6563a84c781e6b9ce9e3a7c3cedefe183b5316b841f0c3693c", "src/board-finish-landing-batch.js": "ae986d7ef013c8ace6d57f8b076a4cb1b6b97240fe3622e512407751a8e8fdd3",
  "src/board-hold-item.js": "585ea3bc7a04a79fd92e9f5188b5015ecec58e38c2248dee7c52b223e08fd0be", "src/board-hold-lane.js": "7e23bd4f00e826d0f996706449951d7f2d46415916b10278161a423e5602c7bc",
  "src/board-intake-outside.js": "c538db4c1fe1a1ef3205df37e93d571b178e56009cba541a70521e16d5bfde60", "src/board-maintain-stale-state.js": "3e290d8baa90c7003aed11defc6b471d6a7530eb4720ae794074bddd0b59b605",
  "src/board-merged.js": "fd009c9ae90154924ddcd8f0e9d08a1da71a16ed2649ce79b68af6c47ba1b1c3", "src/board-next-for.js": "edb202575eb59fc3341fcea4f7ff9fafbfd01fb06d41122173449663382ca137",
  "src/board-open-handoff.js": "76109c6e5476e1897ef34e4e9b419a59d6d486f199f6c79061b13463eff8303e", "src/board-pass-decision.js": "aef27eb84910e7e4a4862c3aacd2b7d05a87efea55f50d125629917bbfc2ce42",
  "src/board-publish-repair.js": "5d9beec4dd1113b60b9233c834d46d055cc7d52da753c89ca5a039f4d4f125be", "src/board-record-health-findings.js": "dc90cbc6eee040ac7b5e3dd78d69fdbc2b25fab556df3e7bb6276499c2d82da6",
  "src/board-record-landing-batch.js": "f2eda3970527e4bb4277856fd577f0c244ffd78634eaafbba19288098c73bb1d", "src/board-record-landing-flake.js": "421d845ece8aedcba23bf57c7d75b667aa18cc1c529b6aa84d02484647b00415",
  "src/board-record-landing-waiver.js": "57585a752d1dc5a8b37b9d47cc841bfef69c946ec7b8cbaa5cf0222cee4e141c", "src/board-record-next-idle.js": "0971022436f40893517978e3a3d674d0761a74348b55229f316ed8eb9fc5f8c0",
  "src/board-record-row-decisions.js": "eedf786b066adcbdf8fef775ff26f73a5b84af0a7285a87e0b39cdf79e509239", "src/board-refreeze.js": "f461576845fcf872990820b2307f71c6c8c70b1faa74a34685bbade1550f26bc",
  "src/board-register.js": "2d1bdb6d97dd91b82460243f523d98a5aab2ee329ea9f0222f44c4cfad1112f2", "src/board-relay-refusal.js": "4dfa8d76aed1e41199a068aa76374e10bbf834c61e1126246efa2fab561988fc",
  "src/board-release-item-hold.js": "2b89e727558978785336f1d0de586924105102f85f41e5a09c56ef6c55cf94e2", "src/board-release-lane.js": "bc2d90af482b26432219617595fb00c5eb8a08cb322c015e476a8fac12e241db",
  "src/board-release.js": "cf62d0bc64eca61251477459852e44cd08b4c5a69da21e1344be5a5ee8e50457", "src/board-remove-item-patch.js": "92e2bbad55c3dd946f4d8835860041cddb25cff85a22da6097bab6d137e1ab9e",
  "src/board-reopen.js": "7db858fd7c50e2067775a6951dc7585bfc3dcb197a7cdce7aa1b48d08d345f77", "src/board-request-companion.js": "b0200c5af20ae2f27b1062a273b743ede0b4327538ce8776169dd52a2aa108e0",
  "src/board-reserve-next-review.js": "598c0043444c2ed7e946e224807f41125e45c0cb4cb84c42856ad26942b3b7c3", "src/board-reserve-review.js": "0f01fa06b6addbe16dea9589d81b70a99942b0e5f969c0dc65c27dd36c523e0c",
  "src/board-review-offer.js": "02f16191a5386000c7b04efbd84b59a2bfa9aab0d3b3307cc3a1c925ca4ae671", "src/board-review-release-note.js": "d5809c3ee8973c197c7c0d3e772c113508be9b75ec33d4809af48cc663545853",
  "src/board-set-lane-lead.js": "0b808a3a0c7f2eed081100c50ed9ed06afeaa8aefeabb56805351aae9b918693", "src/board-shout.js": "c1878b177bf35edfba7a0fa6cff71d621130cb6843daeecfc6cbecc3aa56741f",
  "src/board-submit.js": "735cae6bf13ad4d92d0a14c14224a2da46757a656801701d7a4d8b056dbaeda1", "src/board-take-handoff.js": "48269aed33f41393bec6c87f0b252093ecde278e4ec74da9fc8b36f65ff547b9",
  "src/board-verify.js": "165f68da91adbbe02ec3fd3639ece6f8371e98d13a9b9f3bda9359adedf0444f", "src/board-withdraw.js": "9b24050545dc6c59d9f0b87486cf589b699d9d19ef7fdc2148293a245b0567f7",
  "src/board-escalate.js": "f7067c0e26ad1d1f59a6f35f3ce24878425e4b180ba2f6e9f0732bf31b798f45", "src/board-record-attempt.js": "26f5280b217eac6d3f3591533961c2eefd64abf7eb36da5335cae68ecccf3691",
  "src/board-line-settings.js": "7082cabaf5c606a0c61f37b51e33802669f8b30c1baa0d496c265ce6a5a414bb", "src/board-coordinator-hold.js": "26c6471c07f37a019f1e37ccf24d326dd156fb6ecbc7eb2ea74657681ca04545",
  "src/release-reasons.js": "24423ec2015cd1b535b07220226bf0d3743d900f088430f6ef0970ec1329fe47", "src/submit-outcome.js": "8607c2830b46b748a072730ee8edf4d35ad64c46c185c41236857ff0967ee740",
  "src/submit-handoff-state.js": "2c97cbf20b2b095689b22355bcde9d96a53941a5c0a4132b0c4c2549608c293e", "src/submit-handoff-read.js": "126fc35023902a9fe180a6a50a916c54feb38ab525a071ceb950f724821b1c47",
  "src/rework-family-routing.js": "3b70d67c14e68718f8bc233aa6ead68672b92353d40924e3609f3adfe1c3b665",
};

/** Canonicalize only module and module-relative asset operands, preserving all behavior bytes. */
function normalized(file, source, identities = new Map()) {
  if (file === 'packages/store/src/logic/board/receipts.js') {
    source = source.replace('import { HEALTH_SENTINEL_ENGINE } from "../../../../src/health-sentinel-engine.js";\nexport { HEALTH_SENTINEL_ENGINE } from "../../../../src/health-sentinel-engine.js";', 'export const HEALTH_SENTINEL_ENGINE = 42;');
  }
  for (const [name, leaf] of [['HEALTH_CAP_ENGINE', 'health-cap-engine.js'], ['RECURRING_JOB_ENGINE', 'job-engine.js'], ['RIGOR_NOTICE_ENGINE', 'rigor-notice-engine.js']]) {
    source = source.replace('export { ' + name + ' } from "../../../../src/' + leaf + '";', 'export { ' + name + ' };');
  }
  if (file === 'packages/store/src/io/board/ports.js') {
    source = source.replace("    'conditionalHoldFloor', 'submitHandoffEngines',", "    'submitHandoffEngines',")
      .replace('    conditionalHoldFloor, submitHandoffEngines,', '    submitHandoffEngines,')
      .replace('import { withSeatPresence } from "./seat-presence.js";\n', 'import { withSeatPresence } from "./seat-presence.js";\nimport { conditionalHoldFloor } from "../../../health/index.js";\n');
  }
  const { code, strings } = lex(source);
  const edits = [];
  for (const row of strings) {
    if (!row.text.startsWith('.')) continue;
    const prefix = code.slice(0, row.start);
    if (!/\bfrom\s*$/u.test(prefix) && !/\bimport\s*(?:\(\s*)?$/u.test(prefix)
      && !/\bnew\s+URL\s*\(\s*$/u.test(prefix) && !/\bimport\s*\.\s*meta\s*\.\s*dirname\s*,\s*$/u.test(prefix)) continue;
    const target = posix.normalize(posix.join(posix.dirname(file), row.text));
    edits.push({ ...row, text: JSON.stringify(identities.get(target) ?? target) });
  }
  for (const edit of edits.reverse()) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}


test('the store move preserves every accepted production body except relocation operands [C7,CD60,CD64]', () => {
  const root = resolve(import.meta.dirname, '../../../..');
  const map = JSON.parse(readFileSync(join(root, 'packages/codemap/data/plan/path-map/store.json'), 'utf8'));
  const identities = new Map(Object.entries(map).map(([old, moved]) => [moved, old]));
  for (const [old, digest] of Object.entries(STORE_BODY_HASHES)) {
    assert.equal(typeof map[old], 'string', 'every accepted body retains its exact move identity: ' + old);
    const source = readFileSync(join(root, map[old]), 'utf8');
    assert.equal(createHash('sha256').update(normalized(map[old], source, identities)).digest('hex'), digest, old + ' changes only source-location operands');
  }
});

test('store moved judgment paths retain Strict without widening adjacent files [V4,C7]', () => {
  for (const file of ['packages/store/src/logic/known/main/reworks.js', 'packages/store/src/io/receipts.js', 'packages/store/tests/verdict-check.test.js']) assert.equal(gateJudgmentPath(file), true, file);
  for (const file of ['packages/store/index.js', 'packages/store/src/io/board/capture.js', 'packages/store/src/shell/proof-receipts-adjacent.js', 'packages/store/tests/verdict-check-adjacent.test.js']) assert.equal(gateJudgmentPath(file), false, file);
});

/** A null number is an engine still numbered by its landing merge: its identity is fixed, its number is not yet. */
const ACCEPTED_ENGINE_VALUES = [
  ["ACCEPTED_RELAND_ENGINE",229], ["ACTIVITY_DELIVERY_ENGINE",115], ["ACTIVITY_NEWS_ENGINE",110], ["AGENT_GRANT_ENGINE",127],
  ["AUTO_ESCALATE_ENGINE",50], ["AUTO_SUBMIT_QUARANTINE_ENGINE",178], ["AUTOMATIC_DISPATCH_ENGINE",142], ["BAR_CHECK_ENGINE",108],
  ["BAR_ENGINE",19], ["BAR_READY_ENGINE",96], ["BAR_SIGN_GRANT_ENGINE",134], ["BLOCKED_DEPENDENCIES_ENGINE",197],
  ["BOARD_MEMBERS_ENGINE",121], ["BOARD_PROGRESS_ENGINE",190], ["BOARD_SENTINEL_ENGINE",56], ["BUILDER_FAMILY_REQUIRED_ENGINE",240], ["CAUSE_ENGINE",30],
  ["CHECK_ACCEPT_ENGINE",24], ["CHECK_TIMING_ENGINE",163], ["CHECK_WIDEN_SELF_ENGINE",166], ["CI_FLAKE_ENGINE",65],
  ["CLAIM_IDLE_ENGINE",188], ["CLAIM_PROGRESS_ENGINE",189], ["CLAIM_RETURNS_ENGINE",196], ["CLAUSE_EVIDENCE_ENGINE",224],
  ["CLAUSE_INSPECTION_ENGINE",198], ["COMPANION_ENGINE",123], ["COMPUTER_NAME_ENGINE",116], ["CONFLICT_ENGINE",52], ["CONVEYOR_RETURN_ENGINE",245],
  ["COORDINATOR_ACTIONS_ENGINE",194], ["COORDINATOR_HOLD_ENGINE",72], ["COORDINATOR_SHOUT_KINDS_ENGINE",155], ["COST_ENGINE",171],
  ["COST_INPUT_SPLIT_ENGINE",172], ["CPU_SENTINEL_ENGINE",120], ["CRITICAL_PATH_ENGINE",126], ["CROSS_REPO_DEPENDENCY_ENGINE",128],
  ["DEAD_HANDOFF_RETRY_ENGINE",222], ["DECISION_ORIGIN_ENGINE",111], ["DECISION_QUEUE_ENGINE",119], ["EXIT_RULES_ENGINE",183],
  ["EXPECTED_BUILD_ENGINE",208], ["FAMILY_ALIAS_ENGINE",162], ["FAMILY_DECLARE_ENGINE",170], ["FILE_GROWTH_NOTICE_ENGINE",99],
  ["FLAKE_RATCHET_ENGINE",212], ["FLOW_SIZE_ENGINE",117], ["FOCUS_BOUNDARY_ENGINE",207], ["FOCUS_MILESTONE_ENGINE",107], ["FORCED_MERGE_ENGINE",null],
  ["GATE_RUN_ENGINE",67], ["GENERATED_DOCS_ENGINE",154], ["GONE_CLAIM_ENGINE",139], ["HANDOFF_ENGINE",104],
  ["HEALTH_CAP_ENGINE",62], ["HEALTH_SENTINEL_ENGINE",42], ["HISTORICAL_AUTHORS_ENGINE",80], ["IMPLIES_ENGINE",20],
  ["INFRA_HANDOFF_RECOVERY_ENGINE",234], ["INFRA_RELEASE_ENGINE",233], ["ITEM_FOLDER_ENGINE",199], ["ITEM_NOTES_ENGINE",112], ["ITEM_PATCH_AUTO_ENGINE",145],
  ["ITEM_PATCH_ENGINE",144], ["ITEM_PATCH_SUBMIT_ENGINE",160], ["ITEM_SHOUT_ENGINE",93], ["ITEM_SLICE_ENGINE",205],
  ["KNOWN_MAIN_AUTOFILE_ENGINE",180], ["KNOWN_MAIN_FAILURES_ENGINE",124], ["KNOWN_MAIN_OWNER_PATTERN_ENGINE",179], ["KNOWN_MAIN_REWORKS_ENGINE",151],
  ["KNOWN_MAIN_RUNNING_FILE_ENGINE",225], ["LAND_COLLISION_ENGINE",101], ["LANDING_ENVIRONMENT_ENGINE",85], ["LANDING_LEASE_ENGINE",74],
  ["LANDING_LOCAL_LEASE_ENGINE",94], ["LANE_LEAD_ENGINE",125], ["LEASE_LAPSE_ENGINE",177], ["LEDGER_QUARANTINE_ENGINE",231],
  ["LINE_CAPACITY_ENGINE",103], ["LINE_ORDER_ENGINE",100], ["LINE_SETTINGS_ENGINE",98], ["LIVE_RELEASE_PLACEMENT_ENGINE",213],
  ["LIVE_ROUTE_ENGINE",153], ["LOCAL_LANDING_ENGINE",64], ["MACHINE_VERDICT_ENGINE",242], ["MAIN_AUDIT_ENGINE",138], ["MAIN_RED_FAILURE_LINES_ENGINE",214],
  ["MAIN_RED_FOCUS_ENGINE",232], ["MAIN_RED_WITHDRAW_ENGINE",235], ["MECHANICAL_MERGE_ENGINE",132], ["MERGE_ONLY_VERDICT_ENGINE",129],
  ["MILESTONE_LIMIT_ENGINE",113], ["MILESTONE_PLACEMENT_ENGINE",193], ["MILESTONE_QUEUE_ORDER_ENGINE",215], ["MILESTONE_RANK_ENGINE",34],
  ["MILESTONE_SHIP_ENGINE",45], ["NATIVE_FLAKE_ENGINE",61], ["NEXT_IDLE_ENGINE",169], ["NO_ELIGIBLE_REVIEWER_ENGINE",168],
  ["OUTSIDE_INTAKE_ENGINE",97], ["OWNERSHIP_WAIT_ENGINE",244], ["PARENT_SESSION_ENGINE",90], ["PATCH_AUTHOR_IDENTITY_ENGINE",158], ["PATCH_FOLLOW_ENGINE",165],
  ["PATCH_REVIEW_CUSTODY_ENGINE",157], ["PEOPLE_ENGINE",73], ["PER_ITEM_FULL_SUITE_ENGINE",236], ["PERSON_SIGNING_ENGINE",133],
  ["PINNED_CLAIM_LAPSE_ENGINE",220], ["PIPELINE_CAUSE_ENGINE",184], ["PLAN_MERGE_ENGINE",187], ["PR_BRIDGE_ENGINE",95],
  ["PRIVATE_REHOME_ENGINE",135], ["PROOF_RUN_ENGINE",122], ["QUARANTINE_BACKFILL_ENGINE",230], ["QUARANTINE_CORE_ENGINE",167],
  ["QUARANTINE_VERDICT_ENGINE",176], ["QUEUE_FAIRNESS_ENGINE",216], ["QUEUE_PREEMPT_ENGINE",210], ["QUEUED_RED_RETURN_ENGINE",217], ["QUEUED_START_GRANT_ENGINE",null],
  ["QUOTED_LANDING_FAILURE_ENGINE",105], ["RECURRING_JOB_ENGINE",63], ["REFERENCE_ENGINE",131], ["REJECT_CLAUSE_ENGINE",156],
  ["REJECT_OPEN_ENGINE",226], ["REJECTED_WORK_RETURN_ENGINE",147], ["REJECTION_RETURN_ENGINE",191], ["RELEASE_QUALITY_HOLD_ENGINE",218],
  ["RELEASE_REASONS_ENGINE",185], ["RELEASE_TWICE_HOLD_ENGINE",200], ["RELEASE_TWICE_ROUTE_ENGINE",237], ["REOPEN_CAUSE_ENGINE",137],
  ["REOPEN_FIRST_REFUSAL_ENGINE",66], ["REVIEW_DEFAULT_ENGINE",175], ["REVIEW_FAMILY_RELAX_ENGINE",201], ["REVIEW_FAMILY_SEAT_ENGINE",203],
  ["REVIEW_GRANT_ENGINE",130], ["REVIEW_HEAD_BUILDER_FAMILY_ENGINE",241], ["REVIEW_INDEPENDENCE_ENGINE",148], ["REVIEW_REQUEST_ENGINE",206], ["REVIEW_ROUTING_ENGINE",150],
  ["REVIEW_SKIP_ENGINE",69], ["REVIEW_TIER_ENGINE",159], ["REVIEWS_FIRST_ENGINE",219], ["REWORK_SAME_FAMILY_ENGINE",186],
  ["RIGOR_AUTO_ENGINE",102], ["RIGOR_INSTRUCTIONS_ENGINE",209], ["RIGOR_NOTICE_ENGINE",43], ["ROUTE_CALIBRATION_ENGINE",227],
  ["ROW_DRAFT_ENGINE",55], ["RULING_OWNER_ENGINE",143], ["RUN_TIMING_ENGINE",161], ["SAME_FAMILY_REFUSAL_ENGINE",195],
  ["SEAT_GONE_RELEASE_ENGINE",238], ["SHADOW_TIER1_ENGINE",243], ["SOURCE_ADVANCE_ENGINE",152], ["SPEC_APPROVAL_ENGINE",68], ["SPEC_DRAFT_REFREEZE_ENGINE",149],
  ["SPEC_REVISION_ENGINE",109], ["SPEC_VERDICT_ENGINE",118], ["STALE_STATE_ENGINE",146], ["STRANDED_DEPENDENCY_ENGINE",239],
  ["STRICT_COMPOSITION_ENGINE",174], ["STRICT_RENAME_ENGINE",221], ["STRONG_REJECTION_NOTICE_ENGINE",54], ["SUBMISSION_PROOF_ENGINE",38],
  ["SUBMIT_ADMISSION_ENGINE",136], ["SUBMIT_HANDOFF_ENGINE",182], ["SUBMIT_PROOF_REUSE_ENGINE",202], ["SUBMITTED_CONFLICT_ENGINE",60],
  ["TAKEN_OVER_RELEASE_ENGINE",211], ["TEST_ECONOMICS_ENGINE",141], ["TRAIN_CHECK_REPOINT_ENGINE",181], ["TRAIN_LANDING_ENGINE",164],
  ["TWO_TIER_DIAGNOSIS_ENGINE",228], ["TYPED_REQUESTS_ENGINE",140], ["UNCHANGED_REFREEZE_ENGINE",145], ["UNTOUCHED_CLAIM_ENGINE",204],
  ["USAGE_BATCH_ENGINE",173], ["VENDOR_FAMILY_ENGINE",192], ["VERDICT_REVIEW_ENGINE",33], ["VERDICT_WITHDRAW_ENGINE",106],
  ["VERIFIED_ITEM_HOLD_ENGINE",223], ["VERIFIER_STANDING_ENGINE",48], ["WITHDRAW_MILESTONE_ENGINE",51], ["WORK_ORDER_ENGINE",114]
];

/** Read only literal exported historical engine values; source text is never evaluated. */
function engineRows(source){const code=lex(source).code;return [...code.matchAll(/\bexport\s+const\s+([A-Z][A-Z0-9_]*_ENGINE)\s*=\s*(\d+)\s*;/gu)].map(m=>[m[1],Number(m[2])]);}


test('store extraction preserves the accepted engine identity set and every recorded number [C7,H16]', () => {
  const root = resolve(import.meta.dirname, '../../../..');
  const landing = new Set(ACCEPTED_ENGINE_VALUES.filter(row => row[1] === null).map(row => row[0]));
  const placeholders = readEngineLeaves(join(root, 'src')).filter(row => row.number === undefined || row.number === null).map(row => [row.name, null]);
  const actual = [...styleSources(root).flatMap(row => engineRows(row.source)), ...placeholders]
    .map(([name, number]) => [name, landing.has(name) ? null : number]).sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
  assert.deepEqual(actual, ACCEPTED_ENGINE_VALUES, 'moving a declaration changes neither its identity nor numeric history');
  const leaf = readEngineLeaves(join(root, 'src')).filter(row => row.name === 'HEALTH_SENTINEL_ENGINE');
  assert.deepEqual(leaf, [{ file: 'health-sentinel-engine.js', name: 'HEALTH_SENTINEL_ENGINE', number: 42 }]);
});
