/** @pullboard-test-input source-tree */
/** The frozen check outcome travels with accepts without changing the board schema [V19,V8]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lex } from '../../../../packages/kernel/index.js';
import { AGENT_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { SSH_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { styleSources } from '../../../../packages/codemap/index.js';
import { readEngineLeaves } from '../../../../packages/state/src/io/engine/numbers.js';
import { ENGINE_FOLDER } from '../../../../packages/state/src/io/engine/numbers.js';
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
  mkdirSync(join(repo, 'web'), { recursive: true });
  writeFileSync(join(repo, 'web', 'review-input.txt'), 'before submit\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: verify composes at admission');
  box.git(web, 'merge', '-q', 'main');
  // The landing changes the item's own file with the bytes it reviewed (so the composition merges cleanly), and only once the review checkout exists (an earlier empty landing keeps the submit proof from being reused): an empty or unrelated landing no longer voids a verdict (61b93a7c77).
  const reviewer = join(box.dir, 'moving-check-reviewer');
  const landing = `test -f web/review-input.txt && { [ -d '${reviewer}' ] || { git -C '${repo}' -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -q -m 'feat: land before the review [G1]'; exit 0; }; mkdir -p '${repo}/web' && printf 'export const complete = true;\\n' > '${repo}/web/item-1.js' && git -C '${repo}' add web/item-1.js && git -C '${repo}' -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -q -m 'feat: land during the check [G1]'; }`;
  const { id, commit } = submitted(box, repo, web, 'Moving check', landing);
  box.git(repo, 'switch', '-q', 'main');
  writeFileSync(join(repo, 'web', 'review-input.txt'), 'after submit\n');
  box.git(repo, 'add', 'web/review-input.txt');
  box.git(repo, 'commit', '-q', '-m', 'chore: change the checked review input');
  box.git(repo, 'worktree', 'add', '-q', '--detach', reviewer, commit);
  succeeds(box, reviewer, 'join', 'web');
  const refused = box.run(reviewer, 'verify', String(id), 'accept', '--note', 'Verified while main moves during the check');
  assert.equal(refused.code, 1, refused.out + refused.err);
  assert.match(refused.err, /VERDICT_TRUNK_MOVED/u);
  assert.deepEqual(verdictsOf(repo, id), [], 'a verdict is not recorded for a check that saw a moved main');
});

// Accepted main265b6e8 pins store bodies except relocation operands; re-pinned 10 Nov to the accepted bodies after the layout freeze repointed their imports to cell doors, and src/native-user-directory.js left the store for the gate cell; known-main-autofile and board-access include accepted changes through 73ee00be5d and f12fe8e3bf respectively.
// Held at their old pins, red until an item accepts the change: board-write-lock (2309c5a0b4), native-board-state (e8c0687eaf, 0c571b5a1d), board-shout-audience (1073997c5e), board-next-for (86761ce32e, 4b821dad38), submit-handoff-state (cfe63a4dad) changed in commits that carry no item.
const STORE_BODY_HASHES = {
  "src/exit-rules-continuation.js": "e6ce02be3e201fbf7db44f14e3e7a8a08d21ad6f70a07e8ac1351f719e2d89ed", "src/exit-rules-state.js": "43cff0e1fe6b69e3e06438f9842999ddca53d131e95ba935761bd12755a04e90",
  "src/known-main-autofile.js": "7e3b77ea7a14f8ddd28ae0cf6b94f17a012fa639223eb03216ae8c590610c9b8", "src/board-access.js": "be064e9e94d39ee5b3fd61495ab94df850c4eb1305dc82e51bad25a1c3c06b56",
  "src/board-busy.js": "46dfa1149b6468c47b3d1b75142495c8532397640cfd64300fc3c19371b444d6", "src/board-capture.js": "3bdf7cfe9c7e7a223c1d2b0e5e1deb89e519fa82c4ceb0d1f513d82076f9f3e3",
  "src/board-event-log-migrate.js": "c7702babc4b01fefdb14c37e4afc9c6229c29dbd995dac7872a7529fb7bf8ae8", "src/board-event-log.js": "2aff4b2f29aa9672c30a81bf735671c37597cadd23a56d807de105e5c78454ab",
  "src/board-health.js": "35d82adbe398c2fbf4058135e500a2c862ab0de9c8ae63627e29843d4e51613e", "src/board-hot.js": "d8ddc8535a25d46a738736b1b183fa80a66b9c76bdf69520bd945c7141bb7332",
  "src/board-inventory.js": "a93c42889999e08a5d5c91e9a45af0ae448c3b929dbf1264f65ff5342e9b66de", "src/board-item-dependencies.js": "bcd9f96c6da94ad6f80f31cee806c51f727f8b8c4f3333afe9033eabeb6d6d46",
  "src/board-item-read.js": "ee9d6e2b62dd82ed71706d0fe23bcd467006e0963ff52ac7e68d24bdb4432ba0", "src/board-link-envelope.js": "21dc31bd7351c1c38c81b40fa8bee8c6a7e1970dcb121cea51b407e683f260e4",
  "src/board-link-relay.js": "b216005052b2318b06d0995c441ca42747ccce1aa15c2333dd3bb9a93c19cd40", "src/board-link-ssh.js": "292a01501f32f0dba58141e4332c916ff810a8a2a938ab1c68bba284b80ca9c7",
  "src/board-link-state.js": "ec5bae5c8030702aed67d453d9e92360135328ad302cf1e387f816d8f7041ac3", "src/board-link.js": "5f9514dd7aa0025a00e473d80579c1ced442bb674053c8951ba55248287d8850",
  "src/board-members.js": "354b8ae937d85dbb59fc452e658e49941a70fd7beedf014a2becfa69ba258126", "src/board-migrate.js": "e2c668a8a4a61c620932faadf5e78a5afb34147103514a93ec3408587895c504",
  "src/board-query.js": "8b91c0c7474963c85de7df7fa77df65b1d7c9da990538b5ea582f850dd5a13ad", "src/board-read-auxiliary.js": "6f5758038735a0ed7b875bf73e1fbdf5116922b5c51bfa6311d94eeabff6f044",
  "src/board-read-open.js": "2a0842c798033bb90e6155953c2a919c1637671106b8b837ab01ff65129c8b19", "src/board-rehome.js": "ea3f4a0b7ab9584917f404e072c3b1462b2525b1084487ffaa528bbf0f486a21",
  "src/board-schema-source.js": "5c3452d8f15cd9dae45d0018bbdc8cafab5d33550fe82a932f496ee5dec91f0e", "src/board-schema.js": "105e2b3fa249287b8c95f57c46d1d90e9849b75f652de8e906cacd202eb16409",
  "src/board-signing-recovery.js": "5d29d936067c3514891d4d8bb050124446cd4e62298d5f84e8d86f69bacd6689", "src/board-stats.js": "48f3ed37e8518e7242ecd267b2548fe9deb288c3bb157e96e343bbdde340b4f6",
  "src/board-store-guards.js": "59d61adf6f03ffeb7392bcf964889d1db456a5bcf09af0fd44e95ea4ac8d92ac", "src/board-write-lock.js": "814ecb9d465d12d8c611de7b485f5bd9e75cf1c497a5a8eda2363e522cda5686",
  "src/board.js": "556da6307cb60450852ca298080c710713ee0b8c2aee72b614aa8b64dc531301", "src/companion.js": "079af68eb5eee8d2aecd90e60efec0c363d740f6ccd5dc6e56a3e6bd64c6427b",
  "src/dispatch-eligibility.js": "49b81b4f1de7a5280f5dee6a432fade8c0fd24689deaae2fdf8c455b0c0670ce", "src/exchange.js": "c0ec04a21d0bd036a8e00599b22b474b9f8ad2b89ee410576c0f7feeb71a202e",
  "src/history.js": "fa0fd97a765ad359c5965b98d323a99e7d8a50d0905acd58affea61cfb43dad8", "src/item-check-baseline.js": "6e353d9996bc281b605b23a076a4b6161339ff6ff7b4b3a8162b91ed0b6bcd37",
  "src/known-main-reworks.js": "a5aad98f605c80efcc0aeb349ea8667f1c84424cbca8a8ff3876fc9de6705975", "src/local-state.js": "06fe20320b4ea99c757c5719e72a8e487bee988a4554ba446b14e2a6badaae55",
  "src/main-red-build-routing.js": "b2350feb701160bfbc1b27d8a9330666394f4dbefda1e9da9ca00b9ea0753881", "src/memory-held.js": "3ddaf339187426ca0ab5ac0518409853ded5120b7d247b2788f463144c082c70",
  "src/native-board-state.js": "6d39353b6d3b2a273252deee57cc2820246fdefa897fdcbb7b71e0de293817d8", "src/native-state-clock.js": "cf9fb8899caa4cfc789d2ae26d3c538dffbf0d779d731044e7dbeaffe75e3426", "src/outside-store.js": "d6267a06e55614b297c7d94439bb9257604fc4de3b677b65dd6dd612766c52db",
  "src/proof-receipts.js": "2f35b32fe056888bdf16b18565db4ac5c948f7e4e72653ff7e75c2fe18eacb0b", "src/seat-presence.js": "3f2548cc6ddb50df868364bd043d12a70371ceedbf1f10876bc212e77f1f0497",
  "src/source-advance-return.js": "a3c6716dd9cdeada128fe2a431c224b30a11c8259e2b73835d42a47ba3171c1a", "src/spec-approval-baseline.js": "fb68798d38de29b29fcbe1b7e38523a57213b3fb91034006ed970cbdb4ccaaa1",
  "src/submission-record.js": "d7ca6520a7b797a46e7212e1c57a17d5b4f6abbac8dbe54cf349941c4fb80eb0", "src/typed-requests.js": "59d9b1e501d2a386ac846384222a153bb4226c0a8cfcb041557b5ad20d35608c",
  "src/board-engine-ports.js": "21f5a68f6a8591d850f790851bb744a09f93442db5f6fca81797148311c82d29", "src/board-milestones.js": "07b6e2e6e90ffeaf29ecc17f787eae492ad4a5e15c276520c0b1609f132b3b3b",
  "src/board-store.js": "004f833e18e9cc330154b91d29ab75dbd6c5b6c297c1388a427b7e57698b8381", "src/board-person-authority-schema.js": "0bc862ad4be05a1c67667af8416bf0a1f951e5bb6fa54870ff7664d044b944bc",
  "src/board-activity-delivery-store.js": "ce9630480d0c701868372c9bc869042f17f20438150fa80f4d71ae3b618bc72d", "src/board-activity-feed.js": "4c161d4b2133bac425255d3111802e907d3109c5ce3b42d345b6203ba14abf7b",
  "src/board-activity-news.js": "449dbbc26897a4867120f3422373e73d5e439acf55571da9407117a27de5df18", "src/board-landing-exceptions.js": "99d1840643331a0dfbd602ff1028b206d0e680c1e1f13cc73e486fc6630d9e07",
  "src/board-landing-lease.js": "37c21648ec03eaf9fb01d9045d486e860616ba81a0e05e45564fcda343154d1b", "src/board-landing-local-lease.js": "98fc3ac1334995717c25db764d3702ca738f0488f9dae578c8abb98b46b4c190",
  "src/board-landing-test-defect-history.js": "70d6c4640975d02dc0edbf91365832a216b1bdca2ddb820881012f86da3fdbcb", "src/board-landing-test-defects.js": "4d2cf48713300c028b57c70603b8bc0f14194193de68fe47e3eaecd638a50977",
  "src/board-inbox-store.js": "41ebf52053fcc0bef40fad4d0a7df4958a5c4b6fc77325c377c510a8ff684d01", "src/board-shout-audience.js": "cbee70607b8103c030ae5e3d07c02e9e263c13fa4764b9602a53ac59cb303a94",
  "src/board-worker-inbox.js": "d225b8b3535944363073c6cd0b63e8eb9ec2861534ddd1913807f4636c3a2b7f", "src/board-conditional-holds.js": "ca6b1226fba0060dca0608601d6e813d912fa49e9d1d2d2ffe3a29f988464e07",
  "src/board-health-receipts.js": "8008706cd1e878bb3c6aa46af590905849c512f6b26f0d67825e441877444423", "src/board-recurring-jobs.js": "3b236d573cc47bdd5141ddf6c3d7c1cfb52206ed2ccef64a8ee91cfe8ae87572",
  "src/board-release-claim.js": "b93155ed9b2cf709cfae59e9e0927fee5f93e80f788a59c91eec3d03bee9e5c6", "src/board-stale-claim-release.js": "ae23544ffc83d1f6a93ec2599273151ef4237394b9adb8f8b176fcf83a2d637c",
  "src/board-stale-state-maintenance.js": "47185b8d63d7c2e887b4660a144bfa5408279c44d4ede00c144eeb0228ce3468", "src/board-stale-state-policy.js": "c12e51779801b6961137e58bc7397d98da53469902903ed236eeb55f7fd4a852",
  "src/board-stale-state-store.js": "70266746683aa07300ca781ddd2f7db0c64d31c2dcc6c2c1656d3ca10921d714", "src/board-rigor-auto-source.js": "3472bd63e94a18cf1fcbfac41bc7dec076b656681ef6d0508e4759c072424ac9",
  "src/board-rigor-source.js": "dfdfd4134feba9cd1142dd12c95257b42b00ed6b7639c8c55b06890a7b17db0c", "src/board-rigor.js": "00a9408a8b89c17db41b1fbcc94a41a67e31106e29dba8e97ab1c7d0b436eea2",
  "src/board-claim.js": "c157ffb31f078aef0be59bd4f4e30f7c416084f7b211a1bb50acb4f1c6414b05", "src/board-command-write.js": "03e085754ed7e8c7f147a3cf106bcff779df038e7a81e5e59f51f0eda0ce4f9d",
  "src/board-write-preparation.js": "41e353a4ac017be9dfe130b35e23d233ff93f7502d896a704c03cb129b5e5ded", "src/board-act-on-activity.js": "d0681f7d6c2ebd281e1a0ebd14251e516607c590713659a04aeb65448c27dc64",
  "src/board-activity-delivery.js": "4af3eb9c0b234e11ece8d5dfa1c4ddd9366a22a09034c51c63a00241ed9bf319", "src/board-add-item.js": "a535011f5ae8213df30adf52b6a8a65f57e42c1c9f970dae18563e602d602638",
  "src/board-answer-decision.js": "e226dd3d0520ebfe3f58294321fb4ee1e9f26859af5bec7bb359d75437be2f40", "src/board-append-fact.js": "9cd48c7734c5cda009808ecbcd85bee8942b644bc5f459beb33ed7c86d9fd3d9",
  "src/board-apply-rehome-item.js": "a83031486d74b46148276c90abc1f90a59b3f0feec20d2ab29db52585bda1ca2", "src/board-apply-row-decisions.js": "a95e1fb9eff936309d9887c8460a89af8d8504c4f4fbcb9ca93edc89e11b5fb0",
  "src/board-approve-outside.js": "b589960d8ab4deed1764dcef47e4e05459fbb689f124b3fdc013a02ce76a05f5", "src/board-attach-item-patch.js": "26a5a1e8bfd13bda2a435eef546191c42100f87b2e9b36f880bf59775dcac4cc",
  "src/board-build-order.js": "f0c5a3a384a3d85ed669f76bd72a222efd9ca94b3626a90d32148ae6d7620db8", "src/board-edit-item.js": "c8b5c1321df214c91c4dfcae0b7e9d6abb56ce3ce103fe128f57acfed01cbc8f",
  "src/board-ensure-coordinator.js": "5b24bc6d12347e6563a84c781e6b9ce9e3a7c3cedefe183b5316b841f0c3693c", "src/board-finish-landing-batch.js": "a0f4d8145ff6a941c6713d989feb2b96ea762529e481f514184bbb7aba2553b7",
  "src/board-hold-item.js": "585ea3bc7a04a79fd92e9f5188b5015ecec58e38c2248dee7c52b223e08fd0be", "src/board-hold-lane.js": "7e23bd4f00e826d0f996706449951d7f2d46415916b10278161a423e5602c7bc",
  "src/board-intake-outside.js": "c538db4c1fe1a1ef3205df37e93d571b178e56009cba541a70521e16d5bfde60", "src/board-maintain-stale-state.js": "3e290d8baa90c7003aed11defc6b471d6a7530eb4720ae794074bddd0b59b605",
  "src/board-merged.js": "bdcda3f3aee7dc652cc7f7e965b64bfe852e99f6cfb30ab1ccbb957fdafa5b75", "src/board-next-for.js": "edb202575eb59fc3341fcea4f7ff9fafbfd01fb06d41122173449663382ca137",
  "src/board-open-handoff.js": "76109c6e5476e1897ef34e4e9b419a59d6d486f199f6c79061b13463eff8303e", "src/board-pass-decision.js": "6d91bbec4e76d78e794a835b5ff9681e719ad5600eb0db33398109212a429836",
  "src/board-publish-repair.js": "5d9beec4dd1113b60b9233c834d46d055cc7d52da753c89ca5a039f4d4f125be", "src/board-record-health-findings.js": "dc90cbc6eee040ac7b5e3dd78d69fdbc2b25fab556df3e7bb6276499c2d82da6",
  "src/board-record-landing-batch.js": "b5623c4db17bebeb21bc4082a0e8ffaf22b11d2df6140307d8b62eed394fb06a", "src/board-record-landing-flake.js": "421d845ece8aedcba23bf57c7d75b667aa18cc1c529b6aa84d02484647b00415",
  "src/board-record-landing-waiver.js": "57585a752d1dc5a8b37b9d47cc841bfef69c946ec7b8cbaa5cf0222cee4e141c", "src/board-record-next-idle.js": "0971022436f40893517978e3a3d674d0761a74348b55229f316ed8eb9fc5f8c0",
  "src/board-record-row-decisions.js": "2aaa1933e421bf6b73693139c9b4f9509ce484165234faba2f409c0100a3206d", "src/board-refreeze.js": "665f7d6ef9f92b6f938ffcdec60fc2cca55a50a40c98afec8c0b59a1e7dd45aa",
  "src/board-register.js": "074cbba396fe53561e5cc8ddb7890b14dae35eacd21f924c7ad4bad72bcd359d", "src/board-relay-refusal.js": "4dfa8d76aed1e41199a068aa76374e10bbf834c61e1126246efa2fab561988fc",
  "src/board-release-item-hold.js": "2b89e727558978785336f1d0de586924105102f85f41e5a09c56ef6c55cf94e2", "src/board-release-lane.js": "bc2d90af482b26432219617595fb00c5eb8a08cb322c015e476a8fac12e241db",
  "src/board-release.js": "cf62d0bc64eca61251477459852e44cd08b4c5a69da21e1344be5a5ee8e50457", "src/board-remove-item-patch.js": "92e2bbad55c3dd946f4d8835860041cddb25cff85a22da6097bab6d137e1ab9e",
  "src/board-reopen.js": "bb0564f541a2b592f96920847a5744bb2c219b3b18cd353a1a2a8ad054543c34", "src/board-request-companion.js": "b0200c5af20ae2f27b1062a273b743ede0b4327538ce8776169dd52a2aa108e0",
  "src/board-reserve-next-review.js": "a1acac2408adbc252f3d86be8915148e55961939948a7df8befd9a0c4a283ff7", "src/board-reserve-review.js": "5064ae008cee1b249dacd40e0d887922f81f10291ef0bea8ea5695aebcafa27f",
  "src/board-review-offer.js": "f3823bf1f568ba986ebde439cd5b9e50b5bdcafa3f7c8343b8bc5ca5bc926470", "src/board-review-release-note.js": "d5809c3ee8973c197c7c0d3e772c113508be9b75ec33d4809af48cc663545853",
  "src/board-set-lane-lead.js": "0b808a3a0c7f2eed081100c50ed9ed06afeaa8aefeabb56805351aae9b918693", "src/board-shout.js": "8b75df7c639baf97f9c7ac79483b42fbaaab8cec6101ca288f9e4d69027a92a3",
  "src/board-submit.js": "42d6d2114241983c50b2f09ed9a09830bfe22f648c618b58d5bdd00961dd5698", "src/board-take-handoff.js": "48269aed33f41393bec6c87f0b252093ecde278e4ec74da9fc8b36f65ff547b9",
  "src/board-verify.js": "f71c33ac9d746206046d8deb27c0b91131945e27566d176106117585f9c98dd4", "src/board-withdraw.js": "9b24050545dc6c59d9f0b87486cf589b699d9d19ef7fdc2148293a245b0567f7",
  "src/board-escalate.js": "3a457e6f089927f235f884156e0ec91679ccb91885bb657ea33672103bccad0c", "src/board-record-attempt.js": "26f5280b217eac6d3f3591533961c2eefd64abf7eb36da5335cae68ecccf3691",
  "src/board-line-settings.js": "7082cabaf5c606a0c61f37b51e33802669f8b30c1baa0d496c265ce6a5a414bb", "src/board-coordinator-hold.js": "26c6471c07f37a019f1e37ccf24d326dd156fb6ecbc7eb2ea74657681ca04545",
  "src/release-reasons.js": "d28b1645a22541d89f256af4175bb831ba73c849d7a2e4a3e6faf721229d1cb6", "src/submit-outcome.js": "8607c2830b46b748a072730ee8edf4d35ad64c46c185c41236857ff0967ee740",
  "src/submit-handoff-state.js": "2c97cbf20b2b095689b22355bcde9d96a53941a5c0a4132b0c4c2549608c293e", "src/submit-handoff-read.js": "f1b119d46a15633e2f6adec9f79835b4c965589663ef425e111d0544fb805680",
  "src/rework-family-routing.js": "170eb363b9b721c057f7a21597d7b2befbb57697f8dbc945464c701f36d7557f",
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
  const mismatches = [];
  for (const [old, digest] of Object.entries(STORE_BODY_HASHES)) {
    if (typeof map[old] !== 'string') {
      mismatches.push({ file: old, error: 'missing move identity' });
      continue;
    }
    if (!existsSync(join(root, map[old]))) {
      mismatches.push({ file: old, error: 'moved body missing', path: map[old] });
      continue;
    }
    const source = readFileSync(join(root, map[old]), 'utf8');
    const actual = createHash('sha256').update(normalized(map[old], source, identities)).digest('hex');
    if (actual !== digest) mismatches.push({ file: old, expected: digest, actual });
  }
  assert.deepEqual(mismatches, [], 'each accepted body changes only source-location operands');
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
  ["KNOWN_MAIN_RUNNING_FILE_ENGINE",225], ["LAND_COLLISION_ENGINE",101], ["LANDING_DEFECT_CLOSE_ENGINE",247], ["LANDING_ENVIRONMENT_ENGINE",85], ["LANDING_LEASE_ENGINE",74],
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
  ["REVIEW_GATE_RECEIPT_ENGINE",248], ["REVIEW_GRANT_ENGINE",130], ["REVIEW_HEAD_BUILDER_FAMILY_ENGINE",241], ["REVIEW_INDEPENDENCE_ENGINE",148], ["REVIEW_REQUEST_ENGINE",206], ["REVIEW_ROUTING_ENGINE",150],
  ["REVIEW_SKIP_ENGINE",69], ["REVIEW_TIER_ENGINE",159], ["REVIEWS_FIRST_ENGINE",219], ["REWORK_SAME_FAMILY_ENGINE",186],
  ["RIGOR_AUTO_ENGINE",102], ["RIGOR_INSTRUCTIONS_ENGINE",209], ["RIGOR_NOTICE_ENGINE",43], ["ROUTE_CALIBRATION_ENGINE",227],
  ["ROW_DRAFT_ENGINE",55], ["RULING_OWNER_ENGINE",143], ["RUN_TIMING_ENGINE",161], ["RUNNING_HANDOFF_ITEM_CHECK_ENGINE",250], ["SAME_FAMILY_REFUSAL_ENGINE",195],
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
  const placeholders = readEngineLeaves(join(root, ENGINE_FOLDER)).filter(row => row.number === undefined || row.number === null).map(row => [row.name, null]);
  const actual = [...styleSources(root).flatMap(row => engineRows(row.source)), ...placeholders]
    .map(([name, number]) => [name, landing.has(name) ? null : number]).sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
  assert.deepEqual(actual, ACCEPTED_ENGINE_VALUES, 'moving a declaration changes neither its identity nor numeric history');
  const leaf = readEngineLeaves(join(root, ENGINE_FOLDER)).filter(row => row.name === 'HEALTH_SENTINEL_ENGINE');
  assert.deepEqual(leaf, [{ file: 'health-sentinel-engine.js', name: 'HEALTH_SENTINEL_ENGINE', number: 42 }]);
});
