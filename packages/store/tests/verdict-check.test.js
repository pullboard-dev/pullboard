/** @pullboard-test-input source-tree */
/** The frozen check outcome travels with accepts without changing the board schema [V19,V8]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lex } from '../../kernel/index.js';
import { gateJudgmentPath } from '../../../src/review-tier.js';
import { runFixtureExecFile as execFileSync, runFixtureChild, runFixtureChildAsync, runFixtureGit, safeFixtureDiagnostic } from "../../../test/fixture-child.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { test } from 'node:test';
import * as store from "../src/shell/board.js";
import { openBoard } from "../../../src/native-board.js";

const BIN = resolve(import.meta.dirname, "../../../bin/pullboard.js");
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
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  });
  delete env.NODE_TEST_CONTEXT; // A fixture CLI/compiler child is a normal process, not its parent's Node test worker.
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
  assert.match(box.run(web, 'join', 'web').out, /joined as web-1/);
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
  const args = ['add', 'web', title, '--specs', 'G1', '--criterion', 'The fixture item is complete.'];
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
  const landing = `git -C '${repo}' -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -q -m 'feat: land during the check [G1]'`;
  const { id, commit } = submitted(box, repo, web, 'Moving check', landing);
  box.git(repo, 'switch', '-q', 'main');
  const reviewer = join(box.dir, 'moving-check-reviewer');
  box.git(repo, 'worktree', 'add', '-q', '--detach', reviewer, commit);
  succeeds(box, reviewer, 'join', 'web');
  const refused = box.run(reviewer, 'verify', String(id), 'accept', '--note', 'Verified while main moves during the check');
  assert.equal(refused.code, 1, refused.out + refused.err);
  assert.match(refused.err, /VERDICT_TRUNK_MOVED/u);
  assert.deepEqual(verdictsOf(repo, id), [], 'a verdict is not recorded for a check that saw a moved main');
});

// Accepted main265b6e8: every store production byte is pinned except relocation operands.
const STORE_BODY_HASHES = {
  "src/exit-rules-continuation.js": "c59e6fad99fe25d87bc9ad4b6325c08b6b319a7abcbebca47b1a5a6b8b8a7eb2",
  "src/exit-rules-state.js": "43cff0e1fe6b69e3e06438f9842999ddca53d131e95ba935761bd12755a04e90",
  "src/known-main-autofile.js": "c703ea494daa8e13db4cd262c53ca8b009b936dc3a5a9a4ffb5ebce775c3abbf",
  "src/board-access.js": "82b07eb0dbf0133b2f6aa129785be3cbbab19357ab3c124632594dd1d23fa9e3",
  "src/board-busy.js": "1a5a0e2b011852aa95ded32c90b9a6d2b5933b225156a9e1912a6a6d392e9923",
  "src/board-capture.js": "3bdf7cfe9c7e7a223c1d2b0e5e1deb89e519fa82c4ceb0d1f513d82076f9f3e3",
  "src/board-event-log-migrate.js": "c7702babc4b01fefdb14c37e4afc9c6229c29dbd995dac7872a7529fb7bf8ae8",
  "src/board-event-log.js": "c6c877311b55840ec12359a66d573f31d94ca4fdd786b09ef7fa67ca1ca95123",
  "src/board-health.js": "3cb4c91a37f4e0ba0f7cee9b4605861ce8d3a0fcb320af568cce89e303a6243f",
  "src/board-hot.js": "299b994a75cc4d196f63b9b61b53fb801ea9f1cc2dc5140664e81b19b32119fe",
  "src/board-inventory.js": "902487c8bebace45dd5a6e8b91450af407efa5d023329ca14d342df716936a63",
  "src/board-item-dependencies.js": "f3d9a925c1a4f16e5d2db083467e163bf5b232581c93247926648ad61ce0bc4a",
  "src/board-item-read.js": "2dfc8cb1619951dad0cf1a34e89d8966ffa586e569a6bea09ee951d93c8f1e7c",
  "src/board-link-envelope.js": "9fba04932ea4c41e01477a6e410f7858cc390e3aa160750babcd751758ef959a",
  "src/board-link-relay.js": "07e2633d1eec8e66a8c55aa465ed28c9a1a57c6f56765bbc84f3f8575fc86e38",
  "src/board-link-ssh.js": "dfd7d20e88527440b0b30de013c85f07a2382cba0b15b1cb55fb32ee2722f405",
  "src/board-link-state.js": "9f633b3e38a1768124e26e046baa85e716acd414e79100ef74bd18108a8c887a",
  "src/board-link.js": "743de2b738766be7c7ca36971f7dd9d4ffb5ef8753013804eceb7d8137c64084",
  "src/board-members.js": "206662ee79aef32e5afc5c16dae08afacd73b15a9f85e6f94c6366b23d116c98",
  "src/board-migrate.js": "e2c668a8a4a61c620932faadf5e78a5afb34147103514a93ec3408587895c504",
  "src/board-query.js": "29db37f4b61e1288d20b9da4dde27f849179b267239538fed19a0f0981575240",
  "src/board-read-auxiliary.js": "863d312f98a27b24819386cd111ec188a6d83a2f825625a719f0344660a2938e",
  "src/board-read-open.js": "6ecd4212f160a26b74aa1fe4d8ed62047026c7d3c55c0f0a85c133c2fe569248",
  "src/board-rehome.js": "aeb8e610453e9aabdffcbc47ab3cf1dc259c42833daade38d6381fcc26adcb3e",
  "src/board-schema-source.js": "41c2ec4afa58d3d813e4fb601ffdc0995d825f0506d507d93845c16ed126c56e",
  "src/board-schema.js": "3f8727db55d43a8efcd527d59124ec39c9e987fe2984b17ae68a7caa6599d7e2",
  "src/board-signing-recovery.js": "5d29d936067c3514891d4d8bb050124446cd4e62298d5f84e8d86f69bacd6689",
  "src/board-stats.js": "a8a9c5f4e09002ed4ac641f733005d0ce7e8c9a15f186b27dbd77c8186ce782e",
  "src/board-store-guards.js": "45be4271878fbc6efef60f67fb27bbb65493717c210ba217f0f1fa884cdc41e4",
  "src/board-write-lock.js": "d71963150c69d7b9cd7411e4b32ce63f88257980211d70891d5248a02a1a5423",
  "src/board.js": "9061319a34fe1f6fdee0eeaa1c2786ed013ceaf0e1dd4d159e4b3cd80fe9a707",
  "src/companion.js": "fbd2d4ce3c6fe6545d6203e48bb795c931f1f337e4c88fdee56d280f9ea8adc1",
  "src/dispatch-eligibility.js": "0d1f43d54b522d91ccd5237931128e966666ca655f70fdddf5386fa71b5bb046",
  "src/exchange.js": "c64221aa7b2c7445f2029f7a6690bb6270ea81acd806294a3223714999bc6b10",
  "src/history.js": "3f7bce456de78eba8ac550127f335a4774dff30a122f2d74ab73957a1886cff9",
  "src/item-check-baseline.js": "3b2fd24ce51dff6d106933d7953391bd240aa8fc457294ee140927cd0fbb21f9",
  "src/known-main-reworks.js": "4ac32e78ab1ad576f09f3737b2eae126f62da56a35b56abe23f7e7392aeb33c9",
  "src/local-state.js": "cd40d4a07ae0724dea031d04daf38c0d52c236d39e28d7033e39fb7482171c8e",
  "src/main-red-build-routing.js": "5d234b5859f2f7f7cedff2188bd0c47b639766221fe6128ec8d76a7b68161f63",
  "src/memory-held.js": "3ddaf339187426ca0ab5ac0518409853ded5120b7d247b2788f463144c082c70",
  "src/native-board-state.js": "d4eed3a0c3af6c168cc754439559145c0dde1728563c5d135057c8459610b2da",
  "src/native-state-clock.js": "5b7e5645e21e8e9608c1541d27c87ad71726c976bd0a76ffc20e97be1eef52a8",
  "src/native-user-directory.js": "94f415cdc875eb6c796ff34ae1b9e5adee2a911d6fac3aebac057103acbac1dc",
  "src/outside-store.js": "74db3f9bd5c14c97b0e5e275b2307e495b6d3eceab7d3e5761f3c24ac7ad637b",
  "src/proof-receipts.js": "6836c27cd3729ea77df5dd52b88a65834280fd8d8e7043d730af3461b0268678",
  "src/seat-presence.js": "6406b2968271407b1b55e8a226020bd8a7fdfed22acaff7ac1228e678033f352",
  "src/source-advance-return.js": "80ac28d4c6bdfb310015e40fbe3f61b7e671fcb529fd829915994b9f75563371",
  "src/spec-approval-baseline.js": "d2d50d5ef1832c9dc40ea614acbccd4409ca139ef9d0a88e2a9d827416d706e5",
  "src/submission-record.js": "6dc36adc5f89e8aa717c3f27605f974dc2d5371551ac15f2dbdaa738831ed6f8",
  "src/typed-requests.js": "144547ad5c9567517585536a817d7f96357ed70c7b5c2da59880846c97ca38d5",
  "src/board-engine-ports.js": "cb7df3a76a12b3d42d43ed75c68abeb2faafc368e5b48d58f40719f20e6f8568",
  "src/board-milestones.js": "53e0304990905fada64101ab05ba0d5bbc1a72b2ad7569f7385f2569aa2afda0",
  "src/board-store.js": "8e84aa05e67491f29e0188276fa4bfbe85ecd173a6572772a26321733c63dbf1",
  "src/board-person-authority-schema.js": "3b030720e19347d6fec66f7cb5eb37ca0750de0bb52e62bd3ce18636a422bca6",
  "src/board-activity-delivery-store.js": "5b2abcd793dc3c1004919a701307c75960ab0d1dfd9955a24c44ceba63cf9426",
  "src/board-activity-feed.js": "7d68d27096ddf83bdc4693df7f029d135f83876ffa9533c294cd0cd7266afe20",
  "src/board-activity-news.js": "e4ba06b78729a6bb0ce4265b76dfac15f6c00efa506ad8198122a559400a3eb3",
  "src/board-landing-exceptions.js": "411e1d5aa110c607319baee0079f5df388c56ea9976cafaedc10240ef20f7694",
  "src/board-landing-lease.js": "96b956eb65f4f235322aaaec3cca805c106ec46d6f36a9aab929257a8a02d1c1",
  "src/board-landing-local-lease.js": "4cb79e23083c593805912d87520f3b162c856a3d8288d27c5d52ba1f9a5ef02c",
  "src/board-landing-test-defect-history.js": "f56c3ce729d78945877a6ef51cb97296434a26fbef7eefc2705f3f011b93abf4",
  "src/board-landing-test-defects.js": "8688a58f0f32ba93bf17d1acc2641cf099fb4c5faccbeb0ebbdc878844fcd0ad",
  "src/board-inbox-store.js": "5e6c2f04ccc57782399046d04cc9632a88f0e458e8ca4ecd9301d1618b9aaad8",
  "src/board-shout-audience.js": "56ca64f6a37954210ae1999b3d55a3810856e18acce19697404dbbc98a893bb8",
  "src/board-worker-inbox.js": "4076f083477baa29ee3ab87bb7d9df0d36784ae813570788df954bb45c8c6bec",
  "src/board-conditional-holds.js": "e3eec8826d99951b7e75375375958f26037a425444708aa55914483f0b28a744",
  "src/board-health-receipts.js": "4de130dd28f5253e72b61250b032c86899e4edcd0b3c9ecebd7f608e4a90b995",
  "src/board-recurring-jobs.js": "4da9f590b566f7c0c80def99843c3d8f2893a2e619de64895541af78685c792f",
  "src/board-release-claim.js": "98a566d090a4ac7efacb09480a1707a1306a1c86d5257c3d2a711bb9227c651d",
  "src/board-stale-claim-release.js": "c4429204a64276411d9ed9cf45cadd6fe1c82b8ae715d455fee78fa523b809b5",
  "src/board-stale-state-maintenance.js": "47185b8d63d7c2e887b4660a144bfa5408279c44d4ede00c144eeb0228ce3468",
  "src/board-stale-state-policy.js": "63d2c079500852d66e3eeebd6f0ad76687f5a9e7d95a92e87f0e066c9e9b675a",
  "src/board-stale-state-store.js": "a5d47c58fd94a1e5df7db084bcbbf297aa342a7dd35b21c748ef7caa683167d1",
  "src/board-rigor-auto-source.js": "d092b8ad28999359e6e12a8742f3936866ffb1741bdd4f195c63165ab285b24a",
  "src/board-rigor-source.js": "33f348cb275d515210e30ca5c0cc18ec79a9809ac0dce9583214357507422d55",
  "src/board-rigor.js": "c70ea8a007e325a03ed45da75378d6aa976490dc76b7ac696463d656c4329854",
  "src/board-claim.js": "c02f436b73275876722f0cff9467e37097135dbaf8f89c23dab63951de571f10",
  "src/board-command-write.js": "f0e5f26ee3a3b587245fe91adb89dac36ecd43b561f5689a6849c19a6728ad57",
  "src/board-write-preparation.js": "21c6c64994bf4dde467d02e1788663eaf4027a47082ca3e9ff418c139dcaf186",
  "src/board-act-on-activity.js": "d0681f7d6c2ebd281e1a0ebd14251e516607c590713659a04aeb65448c27dc64",
  "src/board-activity-delivery.js": "cac6d47db07ce4418fe13e6cdf24e10a7a21f4e3d873663e8d3a62dace0df53b",
  "src/board-add-item.js": "f356d7ef9fd71225ca0fbc3cbe2b8011b6d723f35b26582130bad7583a36657a",
  "src/board-answer-decision.js": "79e66b5ea229d5a611225f8436a2d4c534c3eef52b819369aac8f8fba6e5dbd1",
  "src/board-append-fact.js": "c8549096429e2da0e4bce13f56ea4bdb245b842d3bb4fc3f8d6486c8d2d4666e",
  "src/board-apply-rehome-item.js": "6a9159c3fa2b96175ef478caba5d305685e5802ebab75fe37cf369c94e714d19",
  "src/board-apply-row-decisions.js": "0f94ca3b43f20a0e9ab16a1f3d8c1bc4ca0b97e5f7d90b3481c7ad698e037743",
  "src/board-approve-outside.js": "b589960d8ab4deed1764dcef47e4e05459fbb689f124b3fdc013a02ce76a05f5",
  "src/board-attach-item-patch.js": "5f19ebc7c2410111fb78c473f18ffaa1f848081de9002305321d6bd0cd2af199",
  "src/board-build-order.js": "b03c1e66ecb12d623c6d8e223eb3345d9b633a4cc71f11821934ce82618e2e20",
  "src/board-edit-item.js": "fff3edc9cbe51fa471f82781e9118ad8893c8912871aac312102d3c6cab6f0ec",
  "src/board-ensure-coordinator.js": "62bed107881840b44f9a5db1f090041b920d831fd45c2ae4ee830b3265bac4d0",
  "src/board-finish-landing-batch.js": "1fc243c9f65196e363214476721f31630d718d7e8d639cd9b8a1fbd7b9dba3ea",
  "src/board-hold-item.js": "35997635160c6f1992691d9dcf4d17a0f32a0eb6041368ae63b5050624465ad6",
  "src/board-hold-lane.js": "7670d261cbaff4d1ef3111121b7c973bacc52b444420520dded01cd5c3309816",
  "src/board-intake-outside.js": "c538db4c1fe1a1ef3205df37e93d571b178e56009cba541a70521e16d5bfde60",
  "src/board-maintain-stale-state.js": "3e290d8baa90c7003aed11defc6b471d6a7530eb4720ae794074bddd0b59b605",
  "src/board-merged.js": "f1f6ede304a4fe10a95d2f87ce06f5c779aad06f0c2479d6fc339b78dcee3571",
  "src/board-next-for.js": "1e1fec191bbd089b9795457e8413fe91b6bc20b9322376109bc853ce58b13b7f",
  "src/board-open-handoff.js": "9a5a78d4f8d31ea07c67570de77204de561ebb772d57f618b0d5d907c02cf617",
  "src/board-pass-decision.js": "a3a310ec125de14aab02aa55e7679d57ee4e9d23141624ba4a82710fc6a5c850",
  "src/board-publish-repair.js": "b3b389f21e4dc7015a7b724981a60163b4d854d2210ebdc81328d04b8a216350",
  "src/board-record-health-findings.js": "dc90cbc6eee040ac7b5e3dd78d69fdbc2b25fab556df3e7bb6276499c2d82da6",
  "src/board-record-landing-batch.js": "c041096375e8516706091a4f3efbfb9cef9c4b72d60d6d2abdc3a516e3916c56",
  "src/board-record-landing-flake.js": "5f040a4c01c80d8a5454626fa63616536bfe82368b451138dcbcc1bfbe4557fa",
  "src/board-record-landing-waiver.js": "6544622c7af96271219646441bb7eee6db366b9040914c1b887834bbf9f59bae",
  "src/board-record-next-idle.js": "0971022436f40893517978e3a3d674d0761a74348b55229f316ed8eb9fc5f8c0",
  "src/board-record-row-decisions.js": "24a4b338a1525b61284ef73b20eab7c7ce70546fbeaf8d8523b3b83efd83c3db",
  "src/board-refreeze.js": "0f4a3cbd65f58622c4897f7731a9f8816e216fdac42f697cdc03aa32267faf50",
  "src/board-register.js": "ae1f97d3b1ce1dea9918ae49d4f3e8c01fea4f7ae675e72db57a68b8a4ea1330",
  "src/board-relay-refusal.js": "4dfa8d76aed1e41199a068aa76374e10bbf834c61e1126246efa2fab561988fc",
  "src/board-release-item-hold.js": "562ed5d916e6c8ca97d050f90434b02e692d547994f1edd06b8b71ff4d65cba1",
  "src/board-release-lane.js": "9b77bffd4fa8c60486d29cd2a35fbb2719173d048dec4c10e138f46f62b26711",
  "src/board-release.js": "490d0e0401bb2992f5303a2163b63ce93c47c7bca380707d221b511cf99b42b4",
  "src/board-remove-item-patch.js": "a4c920da939c7e061c6237b447b8e8205541e8f0e8ee4a545fefc98ec800aaa9",
  "src/board-reopen.js": "cb64310c8b1e33039750f5de10aaa512a0093a900b66f98483faf676f72c615a",
  "src/board-request-companion.js": "b0200c5af20ae2f27b1062a273b743ede0b4327538ce8776169dd52a2aa108e0",
  "src/board-reserve-next-review.js": "8c13307e4972465a004300ee3c05c68b680cac6b40a676c0f9144ba2546ba916",
  "src/board-reserve-review.js": "f5695d583b4794472d0ac28d7b6d735e10f67564144bc15b9b935e0a5e044e66",
  "src/board-review-offer.js": "bb1ca1f0ced87b7165a1e04fad4b4160f346a8c5151c5ab3f0128233a97cdaf9",
  "src/board-review-release-note.js": "5316db7bcf6d1d89dc6d194313bae0bff5f582d232881af6ac1a289704fe6198",
  "src/board-set-lane-lead.js": "26706c0e0ed15d66cfb64331166a62bc70326f6926956194658f9b6bda4c4d02",
  "src/board-shout.js": "faed05f7139c863d53f1127ca8e68da8271c4c851d9f57cb9a7e5779c7a45cc9",
  "src/board-submit.js": "e24442e6ff026b538ae3eef038a670188ded36c6822fe069687cfa414a175e87",
  "src/board-take-handoff.js": "129cc2afc88455f5dd7e9d7e364b5b4e217a64f2d7222e14e334ff9c5ed259a2",
  "src/board-verify.js": "2a90ca91e8f93e87e1c4c4b0ec4ce5b1730a74a784f3dc5b7b530c9e9143a84d",
  "src/board-withdraw.js": "a22d87811dd149577909b18d1717374eed590b350e1229eac262e8e2a0024cda",
  "src/board-escalate.js": "e439919e9cb3dae7652c97d9b3f901a1563857a5e6c974dcadf02c6d414c7017",
  "src/board-record-attempt.js": "26f5280b217eac6d3f3591533961c2eefd64abf7eb36da5335cae68ecccf3691",
  "src/board-line-settings.js": "26bb797e9e0b06bb2d74e760b6037f195b24f52d702337de23ef36de3647d3fb",
  "src/board-coordinator-hold.js": "bf21b2037dd58cf22c0de7a381f3e7a2ef26e5d94dd63d5597e30642045f267f",
  "src/release-reasons.js": "47204ae49ebd6a1f11f33da11a360f3e5659018d88c29454dc5e7b2b0e4e6580",
  "src/submit-outcome.js": "e1105278e315ba5da60af99807ac6ca3c70a978a04fc27fcf653275367b49a3a",
  "src/submit-handoff-state.js": "46968d02c4a43f9fffb10760f99d06a61cb4395de0aabf86264ea0662604c81d",
  "src/submit-handoff-read.js": "fb7b372a2c4a235189bfebab33d6c23a08e85663413c5e56d10f4dc185b54f1d",
  "src/rework-family-routing.js": "b33b2823073e350cc960963118ada60cbcf208c990c321a21c39d0d47d7e0e28"
};

/** Canonicalize only module and module-relative asset operands, preserving all behavior bytes. */
function normalized(file,source,identities=new Map()) {let s=source;const{code,strings}=lex(source),edits=[];for(const r of strings){if(!r.text.startsWith('.'))continue;const prefix=code.slice(0,r.start);if(!/\bfrom\s*$/u.test(prefix)&&!/\bimport\s*(?:\(\s*)?$/u.test(prefix)&&!/\bnew\s+URL\s*\(\s*$/u.test(prefix)&&!/\bimport\s*\.\s*meta\s*\.\s*dirname\s*,\s*$/u.test(prefix))continue;const target=posix.normalize(posix.join(posix.dirname(file),r.text));edits.push({...r,text:JSON.stringify(identities.get(target)??target)});}for(const e of edits.reverse())s=s.slice(0,e.start)+e.text+s.slice(e.end);return s;}


test('the store move preserves every accepted production body except relocation operands [C7,CD60,CD64]', () => {
  const root = resolve(import.meta.dirname, '../../..');
  const map = JSON.parse(readFileSync(join(root, 'bin/cells-plan/path-map/store.json'), 'utf8'));
  const identities = new Map(Object.entries(map).map(([old, moved]) => [moved, old]));
  for (const [old, digest] of Object.entries(STORE_BODY_HASHES)) {
    assert.equal(typeof map[old], 'string', 'every accepted body retains its exact move identity: ' + old);
    const source = readFileSync(join(root, map[old]), 'utf8');
    assert.equal(createHash('sha256').update(normalized(map[old], source, identities)).digest('hex'), digest, old + ' changes only source-location operands');
  }
});

test('store moved judgment paths retain Strict without widening adjacent files [V4,C7]', () => {
  for (const file of ['packages/store/src/core/known-main-reworks.js', 'packages/store/src/shell/proof-receipts.js', 'packages/store/tests/verdict-check.test.js']) assert.equal(gateJudgmentPath(file), true, file);
  for (const file of ['packages/store/index.js', 'packages/store/src/shell/board-capture.js', 'packages/store/src/shell/proof-receipts-adjacent.js', 'packages/store/tests/verdict-check-adjacent.test.js']) assert.equal(gateJudgmentPath(file), false, file);
});
