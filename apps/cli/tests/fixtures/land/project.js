/** Shared real Git landing setup for independently scheduled suites [B3,R3]. */
import { fixtureSwitchSource } from '../runner/switches.js';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runFixtureChildAsync } from '../child.js';
import { inProcessHooksOn } from '../hook/mode.js';
import {
  verifySettled,
  verifySettledSync,
} from '../submit/settle.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../testkit.js';

export function makeLandProjectFixtures({ sandbox, project, commitFile }) {
  const FILES = [1, 2, 3, 4].map(n => `web/land-${n}.test.js`);
/** Emit real failing TAP and a separate single-file runner, recording every invocation. */
function gateFixture(box) {
  const gate = join(box.dir, 'land-gate.cjs');
  const checks = join(box.dir, 'land-check.cjs');
  const callPath = join(box.dir, 'land-gate-calls.jsonl');
  const hold = join(box.dir, 'hold');
  const entered = join(box.dir, 'entered');
  const release = join(box.dir, 'release');
  const trace = join(box.dir, 'gate-trace.jsonl');
  // The bare origin landProject adds; a land job pushes the trunk there.
  const origin = join(box.dir, 'origin.git');
  writeFileSync(gate, [
    "const fs = require('node:fs'); const path = require('node:path');",
    `const calls = ${JSON.stringify(callPath)}; const hold = ${JSON.stringify(hold)}; const entered = ${JSON.stringify(entered)}; const release = ${JSON.stringify(release)}; const trace = ${JSON.stringify(trace)};`,
    fixtureSwitchSource(box.env),
    "const root = process.cwd(); const args = process.argv.slice(2); fs.appendFileSync(calls, JSON.stringify(args) + '\\n');",
    "const alone = args.includes('--alone'); const web = path.join(root, 'web'); const files = alone ? args.filter(a => a !== '--alone') : (fs.existsSync(web) ? fs.readdirSync(web).filter(n => /^land-\\d+\\.test\\.js$/.test(n)).map(n => 'web/' + n) : []);",
    "fs.appendFileSync(trace, JSON.stringify({ alone, files }) + '\\n'); const fullRuns = fs.readFileSync(trace, 'utf8').trim().split('\\n').map(line => JSON.parse(line)).filter(row => !row.alone).length;",
    "if (!alone && fs.existsSync(hold) && (fs.readFileSync(hold, 'utf8') === 'armed' || Number(fs.readFileSync(hold, 'utf8')) === fullRuns)) { fs.writeFileSync(entered, root); const end = Date.now() + 20000; while (!fs.existsSync(release) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); if (!fs.existsSync(release)) process.exit(24); }",
    "if (fixtureSwitch('LAND_UNNAMED_RED') === '1' && !alone && files.length > 1) { console.log('TAP version 13'); console.log('1..0'); process.exit(1); }",
    // LAND_RED_AFTER_LANDING: a FLAKE file fails a full run only once the trunk the land jobs push to holds it, so the item's own gate is green
    // and a main-wide test run after its landing is red, as a main test no import links to the item breaks [M2,R3,#12184].
    `const onTrunk = file => require('node:child_process').spawnSync('git', ['--git-dir', ${JSON.stringify(origin)}, 'cat-file', '-e', 'main:' + file]).status === 0;`,
    "console.log('TAP version 13'); let failed = 0;",
    "files.forEach((file, i) => { const text = fs.readFileSync(path.resolve(root, file), 'utf8'); const red = fixtureSwitch('LAND_SUPPRESS_RED') !== '1' && (text.includes('RED') || !alone && text.includes('FLAKE') && (fixtureSwitch('LAND_RED_AFTER_LANDING') !== '1' || onTrunk(file))); const name = (/NAME:(\\S+)/.exec(text) || [])[1] || file + ' keeps the landed behavior'; console.log('# Subtest: ' + name); console.log((red ? 'not ok ' : 'ok ') + (i + 1) + ' - ' + name); if (red) { failed++; console.log('  ---'); console.log('  location: ' + path.resolve(root, file) + ':1:1'); console.log('  failureType: testCodeFailure'); console.log('  error: fixture behavior is red'); console.log('  ...'); } });",
    "const cancelled = fixtureSwitch('LAND_CANCEL') === '1' && !alone && failed > 0 ? 1 : 0; if (cancelled) { console.log('# Subtest: cancelled fixture'); console.log('not ok ' + (files.length + 1) + ' - cancelled fixture'); console.log('  ---'); console.log('  location: ' + path.resolve(root, files[0]) + ':2:1'); console.log('  failureType: cancelledByParent'); console.log('  error: Promise resolution is still pending but the event loop has already resolved'); console.log('  ...'); }",
    "console.log('1..' + (files.length + cancelled)); console.log('# tests ' + (files.length + cancelled)); console.log('# pass ' + (files.length - failed)); console.log('# fail ' + failed); console.log('# cancelled ' + cancelled); process.exitCode = failed || cancelled ? 1 : 0;",
  ].join('\n'));
  writeFileSync(checks, "const fs = require('node:fs'); const file = process.argv[2]; if (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').trim()) process.exit(1);\n");
  return { gate: `node ${JSON.stringify(gate)}`, affected: `node ${JSON.stringify(gate)} --alone`, checks, calls: callPath, hold, entered, release, trace };
}

/** Create a private initialized project with a real bare origin and active hooks. */
function landProject({ withWorktree = true } = {}) {
  const box = sandbox();
  const commands = gateFixture(box);
  const fixture = project(commands.gate, box, { withWorktree });
  const path = join(fixture.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.affectedTests = commands.affected;
  // These suites prove the bisect; a suite that proves the split sets landing.splitRed itself.
  config.landing = { ...(config.landing ?? {}), splitRed: false };
  writeFileSync(path, JSON.stringify(config, null, 2));
  fixture.git(fixture.repo, 'add', 'pullboard.json');
  fixture.git(fixture.repo, 'commit', '-q', '-m', 'chore: configure landing');
  if (withWorktree) fixture.git(fixture.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'origin.git');
  fixture.git(box.dir, 'init', '-q', '--bare', remote);
  fixture.git(fixture.repo, 'remote', 'add', 'origin', remote);
  const pushed = fixture.tryGit(fixture.repo, 'push', '-q', '-u', 'origin', 'main');
  assert.equal(pushed.status, 0, pushed.stderr);
  return { ...fixture, ...commands, remote };
}

/** Give one private item a distinct canonical lane identity and an independent main base. */
function itemWorktree(box, number, file = FILES[number - 1], afterIds = [], check = `node ${JSON.stringify(box.checks)} ${JSON.stringify(file)}`) {
  const path = join(box.dir, `land-${number}`);
  box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/land-${number}`, path, 'main');
  assert.equal(joinFixtureSeat(box, path, 'web').code, 0);
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: `Land fixture ${number}`,
    criterion: `land fixture ${number} remains valid`, check,
    args: ['--specs', 'G1', ...(afterIds.length ? ['--after', afterIds.join(',')] : [])] }).item_id;
  assert.equal(box.run(path, 'claim', String(item)).code, 0);
  return { path, item, file };
}

/** itemWorktree answered in this process: the same worktree, seat, item and claim without a node start-up per step [B3]. */
async function itemWorktreeLocal(box, number, file = FILES[number - 1]) {
  const path = join(box.dir, `land-${number}`);
  box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/land-${number}`, path, 'main');
  assert.equal((await joinFixtureSeat(box, path, 'web', { run: box.runLocal })).code, 0);
  const item = (await fileFixtureItem(box, box.repo, { lane: 'web', title: `Land fixture ${number}`,
    criterion: `land fixture ${number} remains valid`, check: `node ${JSON.stringify(box.checks)} ${JSON.stringify(file)}`,
    args: ['--specs', 'G1'], run: box.runLocal })).item_id;
  assert.equal((await box.runLocal(path, 'claim', String(item))).code, 0);
  return { path, item, file };
}

/** Build and submit a private fixture through its real hooks and item check. */
function submitItem(box, entry, contents = 'PASS\n') {
  const committed = commitFile(box, entry.path, entry.file, contents, `feat(web): build land fixture ${entry.item} [G1]`);
  assert.equal(committed.status, 0, committed.stderr);
  entry.commit = box.git(entry.path, 'rev-parse', 'HEAD');
  const submitted = box.run(entry.path, 'submit', String(entry.item), '--no-next');
  assert.equal(submitted.code, 0, submitted.err);
  return entry;
}

/** Verify only private fixture items at their actual submitted commits. */
function acceptItem(box, entry) {
  entry.reviewedTrunk = box.git(box.repo, 'rev-parse', 'main');
  box.git(box.repo, 'switch', '-q', '--detach', entry.commit);
  try {
    const verdict = verifySettledSync(box, box.repo, ['verify', String(entry.item), 'accept', '--as', 'coordinator', '--note', 'private landing fixture check passed']);
    assert.equal(verdict.code, 0, verdict.err);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
}
/**
 * Commit an item's change through its real hooks without blocking the other items' commits.
 * Why: each commit starts the hook CLI twice; sixteen in a row cost more than the file's whole budget [B3].
 */
async function commitItemLocal(box, entry, contents = 'PASS\n') {
  mkdirSync(join(entry.path, entry.file, '..'), { recursive: true });
  writeFileSync(join(entry.path, entry.file), contents);
  box.git(entry.path, 'add', '-A');
  const args = ['commit', '-q', '-m', `feat(web): build land fixture ${entry.item} [G1]`];
  // With test.inProcessHooks on, the hooks run in this process; otherwise the real hooks run as child processes [C7,#10412].
  const committed = inProcessHooksOn(box.env) ? await box.tryGitInProcess(entry.path, ...args) : await runFixtureChildAsync('git', args, { cwd: entry.path, env: box.env, encoding: 'utf8' });
  assert.equal(committed.status, 0, committed.stderr);
  entry.commit = box.git(entry.path, 'rev-parse', 'HEAD');
  return entry;
}

/** Submit an already committed item in this process, skipping the node start-up [B3]. */
async function submitItemLocal(box, entry) {
  const submitted = await box.runLocal(entry.path, 'submit', String(entry.item), '--no-next');
  assert.equal(submitted.code, 0, submitted.err);
  return entry;
}

/** acceptItem answered in this process [B3]. */
async function acceptItemLocal(box, entry) {
  entry.reviewedTrunk = box.git(box.repo, 'rev-parse', 'main');
  box.git(box.repo, 'switch', '-q', '--detach', entry.commit);
  try {
    const verdict = await verifySettled(box, box.runLocal, box.repo, ['verify', String(entry.item), 'accept', '--as', 'coordinator', '--note', 'private landing fixture check passed']);
    assert.equal(verdict.code, 0, verdict.err);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
}
/**
 * Advance main by one unrelated commit after an item's submit. Why: these fixtures submit with their red suppressed, so a
 * landing on the submit's own main would reuse that green receipt (#3685) and never run the landing gate under test.
 */
function moveMainPastSubmit(box, number = 0) {
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    const moved = commitFile(box, box.repo, `web/main-moved-${number}.txt`, `main moved past submit ${number}\n`, `chore(web): main moves past the submit ${number} [G1]`);
    assert.equal(moved.status, 0, moved.stderr);
  } finally { delete box.env.LAND_SUPPRESS_RED; }
}

/** Prepare four independent submitted items and accept them in a caller-selected verdict order. */
function verifiedFour(box, { red, flaky, order = [0, 1, 2, 3] } = {}) {
  box.env.LAND_SUPPRESS_RED = '1';
  const entries = FILES.map((file, index) => itemWorktree(box, index + 1, file));
  for (const [index, entry] of entries.entries()) submitItem(box, entry, index === red ? 'RED\n' : (Array.isArray(flaky) ? flaky.includes(index) : index === flaky) ? 'FLAKE\n' : 'PASS\n');
  for (const index of order) acceptItem(box, entries[index]);
  delete box.env.LAND_SUPPRESS_RED;
  return entries;
}

  return { FILES, landProject, itemWorktree, submitItem, acceptItem, itemWorktreeLocal, commitItemLocal, submitItemLocal, acceptItemLocal, moveMainPastSubmit, verifiedFour };
}
