/** Integrity checks use throwaway git repositories and real board databases (A6). */
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import assert from 'node:assert/strict';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  delimiter,
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../../../../packages/store/index.js';
import { hookScript } from '../../../../packages/commits/index.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';


const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const sandboxes = [];

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/**
 * Create a committed repo with a board and isolated git identity for one integrity scenario.
 */
async function boardBox({ initialize = true, repoName = 'repo', lanes = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-doctor-'));
  sandboxes.push(dir);
  const root = join(dir, repoName);
  mkdirSync(root);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  Object.assign(env, {
    PULLBOARD_HOME: join(dir, 'home'),
    HOME: join(dir, 'private-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Doctor Test',
    GIT_AUTHOR_EMAIL: 'doctor@example.com',
    GIT_COMMITTER_NAME: 'Doctor Test',
    GIT_COMMITTER_EMAIL: 'doctor@example.com',
  });
  delete env.PULLBOARD_RELAY_TOKEN;
  const git = (...args) => runFixtureGit(args, { cwd: root, env, encoding: 'utf8' });
  const run = (...args) => runCliInProcess(args, { cwd: root, env });
  git('init', '-q', '-b', 'main');
  const mergeHook = join(root, '.git', 'hooks', 'pre-merge-commit');
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
  writeFileSync(mergeHook, hookScript('pre-merge-commit'));
  chmodSync(mergeHook, 0o755);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes }, null, 2));
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: setup');
  const dbFile = join(root, '.git', 'pullboard', 'board.sqlite');
  if (initialize) { const result = await run('status'); assert.equal(result.status, 0, result.stderr || result.stdout); }
  else mkdirSync(join(root, '.git', 'pullboard'), { recursive: true });
  return { dir, root, env, git, run, dbFile };
}

/** Exercise installed-release repair advice independently of the checkout running this test. */
function runRelease(box, ...args) {
  const release = join(box.dir, 'installed-release');
  mkdirSync(release, { recursive: true });
  copyPackageFiles(resolve(import.meta.dirname, '../../../..'), release);
  return runFixtureChild(process.execPath, [join(release, 'apps/cli/pullboard.js'), ...args], { cwd: box.root, env: box.env, encoding: 'utf8' });
}

/**
 * Open the test board directly so a fixture can model corruption that normal triggers prevent.
 */
function mutate(box, action) {
  const db = new DatabaseSync(box.dbFile);
  try {
    action(db);
  } finally {
    db.close();
  }
}

/**
 * Add a valid open row, then return its integer id for a corruption test.
 */
function addItem(box) {
  let id;
  mutate(box, (db) => {
    db.prepare('INSERT INTO item (item_lane, item_title, item_created_by, item_created_at, item_updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('web', 'Doctor fixture', 'coordinator', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z');
    id = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  });
  return id;
}

test('doctor reports a clean board in one line and leaves it unchanged [A6]', async () => {
  const box = await boardBox();
  const before = readFileSync(box.dbFile);
  const result = await box.local('doctor');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'board is clean\n');
  assert.equal(result.stderr, '');
  assert.deepEqual(readFileSync(box.dbFile), before);
});

test('doctor names an unwired hook and resume gives the repair line [L3]', async () => {
  const box = await boardBox();
  const hooks = join(box.root, '.husky');
  mkdirSync(hooks);
  box.git('config', 'core.hooksPath', '.husky');
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nnpx lint-staged\n');
  writeFileSync(join(hooks, 'pre-merge-commit'), '#!/bin/sh\npullboard hook pre-merge-commit "$@"\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  chmodSync(join(hooks, 'pre-merge-commit'), 0o755);
  const expected = 'active Git hook .husky/pre-commit does not call pullboard hook pre-commit';

  const doctor = await box.local('doctor');
  assert.equal(doctor.status, 1);
  assert.equal(doctor.stdout.split('\n').filter((line) => line.includes(expected)).length, 1, doctor.stdout);
  assert.ok(doctor.stdout.includes(`${expected}; repair: add this line: pullboard hook pre-commit "$@"`), doctor.stdout);
  const resume = await box.local('resume', '--diagnostics');
  assert.equal(resume.status, 0, resume.stderr);
  assert.equal(resume.stdout.split('\n').filter((line) => line.includes(expected)).length, 1, resume.stdout);
  assert.ok(resume.stdout.includes(`${expected}; add this line: pullboard hook pre-commit "$@"`), resume.stdout);
  const doctorJson = await box.local('doctor', '--json');
  assert.equal(doctorJson.status, 1);
  const finding = { code: 'HOOK_UNWIRED', message: expected, next: 'add this line: pullboard hook pre-commit "$@"' };
  assert.deepEqual(JSON.parse(doctorJson.stdout).problems, [finding]);
  const resumeJson = await box.local('resume', '--diagnostics', '--json');
  assert.equal(resumeJson.status, 0, resumeJson.stderr);
  assert.deepEqual(JSON.parse(resumeJson.stdout).hookProblems, [finding]);

  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\npullboard hook pre-commit "$@"\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  box.git('config', 'core.hooksPath', hooks);
  assert.doesNotMatch((await box.local('doctor')).stdout, /HOOK_UNWIRED|active Git hook/u);
  assert.doesNotMatch((await box.local('resume', '--diagnostics')).stdout, /HOOK_UNWIRED|active Git hook/u);
});


/** Quote one private fixture path as a shell word without expanding user text. */
function hookWord(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

/** Install a real CLI wrapper whose marker proves whether Git actually invokes Pullboard. */
async function executedHookBox() {
  const box = await boardBox();
  const bin = join(box.dir, 'private-bin');
  const hooks = join(box.root, '.husky');
  const marker = join(box.dir, 'executed-hook');
  mkdirSync(bin); mkdirSync(hooks);
  writeFileSync(join(bin, 'pullboard'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$PULLBOARD_TEST_HOOK_MARKER"\nexec '
    + hookWord(process.execPath) + ' ' + hookWord(BIN) + ' "$@"\n');
  chmodSync(join(bin, 'pullboard'), 0o755);
  box.env.PATH = bin + delimiter + box.env.PATH;
  box.env.PULLBOARD_TEST_HOOK_MARKER = marker;
  box.git('config', 'core.hooksPath', '.husky');
  writeFileSync(join(hooks, 'pre-merge-commit'), '#!/bin/sh\npullboard hook pre-merge-commit "$@"\n');
  chmodSync(join(hooks, 'pre-merge-commit'), 0o755);
  return { ...box, hook: join(hooks, 'pre-commit'), marker };
}

test('doctor and resume accept env delegation that real Git executes [L3]', async () => {
  const box = await executedHookBox();
  for (const source of ['#!/bin/sh\nenv pullboard hook pre-commit "$@"\n',
    '#!/bin/sh\nexec env pullboard hook pre-commit "$@"\n']) {
    writeFileSync(box.hook, source); chmodSync(box.hook, 0o755);
    writeFileSync(box.marker, '');
    box.git('commit', '--allow-empty', '-q', '-m', 'chore: actual hook control');
    assert.match(readFileSync(box.marker, 'utf8'), /^hook pre-commit\n$/u,
      'the real Git pre-commit hook invoked the actual submitted CLI once');
    writeFileSync(box.marker, '');
    const doctor = await box.local('doctor');
    assert.equal(doctor.status, 0, 'an executed env delegation is wired');
    assert.equal(doctor.stdout, 'board is clean\n');
    const resume = await box.local('resume', '--diagnostics');
    assert.equal(resume.status, 0);
    assert.doesNotMatch(resume.stdout, /active Git hook|HOOK_UNWIRED/u);
    assert.deepEqual(JSON.parse((await box.local('doctor', '--json')).stdout).problems, []);
    assert.deepEqual(JSON.parse((await box.local('resume', '--diagnostics', '--json')).stdout).hookProblems, []);
    assert.equal(readFileSync(box.marker, 'utf8'), '', 'diagnosis never executes the hook');
    assert.equal(readFileSync(box.hook, 'utf8'), source, 'diagnosis never edits the hook');
  }
});

test('doctor and resume accept env assignments that real Git executes [L3]', async () => {
  const box = await executedHookBox();
  for (const source of [
    '#!/bin/sh\nenv REVIEWER_HOOK_CONTROL=1 pullboard hook pre-commit "$@"\n',
    '#!/bin/sh\nexec env FIRST=one SECOND="two words" EMPTY= pullboard hook pre-commit "$@"\n',
    "#!/bin/sh\nenv FIRST='two words' SECOND=three pullboard hook pre-commit \"$@\"\n",
  ]) {
    writeFileSync(box.hook, source); chmodSync(box.hook, 0o755);
    writeFileSync(box.marker, '');
    box.git('commit', '--allow-empty', '-q', '-m', 'chore: actual hook control');
    assert.match(readFileSync(box.marker, 'utf8'), /^hook pre-commit\n$/u,
      'the real Git pre-commit hook invoked the actual submitted CLI once');
    writeFileSync(box.marker, '');
    const doctor = await box.local('doctor');
    assert.equal(doctor.status, 0, 'an executed env delegation is wired');
    assert.equal(doctor.stdout, 'board is clean\n');
    const resume = await box.local('resume', '--diagnostics');
    assert.equal(resume.status, 0);
    assert.doesNotMatch(resume.stdout, /active Git hook|HOOK_UNWIRED/u);
    assert.deepEqual(JSON.parse((await box.local('doctor', '--json')).stdout).problems, []);
    assert.deepEqual(JSON.parse((await box.local('resume', '--diagnostics', '--json')).stdout).hookProblems, []);
    assert.equal(readFileSync(box.marker, 'utf8'), '', 'diagnosis never executes the hook');
    assert.equal(readFileSync(box.hook, 'utf8'), source, 'diagnosis never edits the hook');
  }
});

test('doctor and resume reject printed heredocs that real Git never executes [L3]', async () => {
  const box = await executedHookBox();
  const message = 'active Git hook .husky/pre-commit does not call pullboard hook pre-commit';
  const delegation = 'pullboard hook pre-commit "$@"';
  const finding = { code: 'HOOK_UNWIRED', message, next: 'add this line: ' + delegation };
  for (const source of [
    '#!/bin/sh\ncat <<\'DOCUMENTATION\'\npullboard hook pre-commit "$@"\nDOCUMENTATION\n',
    '#!/bin/sh\ncat <<DOCUMENTATION\npullboard hook pre-commit "$@"\nDOCUMENTATION\n',
    '#!/bin/sh\ncat <<-\'DOCUMENTATION\'\n\tpullboard hook pre-commit "$@"\n\tDOCUMENTATION\n',
    '#!/bin/sh\ncat <<FIRST <<"SECOND"\nexample\nFIRST\npullboard hook pre-commit "$@"\nSECOND\n',
  ]) {
    writeFileSync(box.hook, source); chmodSync(box.hook, 0o755);
    writeFileSync(box.marker, '');
    box.git('commit', '--allow-empty', '-q', '-m', 'chore: documentation control');
    assert.equal(readFileSync(box.marker, 'utf8'), '', 'Git only printed documentation; it never called the CLI');
    const doctor = await box.local('doctor');
    assert.equal(doctor.status, 1, 'printed heredoc text cannot wire the active hook');
    assert.ok(doctor.stdout.includes(message + '; repair: ' + finding.next));
    const resume = await box.local('resume', '--diagnostics');
    assert.equal(resume.status, 0);
    assert.ok(resume.stdout.includes(message + '; ' + finding.next));
    assert.deepEqual(JSON.parse((await box.local('doctor', '--json')).stdout).problems, [finding]);
    assert.deepEqual(JSON.parse((await box.local('resume', '--diagnostics', '--json')).stdout).hookProblems, [finding]);
    assert.equal(readFileSync(box.marker, 'utf8'), '', 'diagnosis never executes the printed example');
    assert.equal(readFileSync(box.hook, 'utf8'), source, 'diagnosis leaves documentation untouched');
    writeFileSync(box.hook, source + delegation + '\n');
    box.git('commit', '--allow-empty', '-q', '-m', 'chore: exact repair control');
    assert.match(readFileSync(box.marker, 'utf8'), /^hook pre-commit\n$/u, 'the exact repair line really invokes the CLI');
    assert.equal((await box.local('doctor')).stdout, 'board is clean\n');
    assert.doesNotMatch((await box.local('resume', '--diagnostics')).stdout, /active Git hook|HOOK_UNWIRED/u);
  }
});

test('text HELD refusal ends with the same next step as JSON [L3]', async () => {
  const box = await boardBox({ lanes: { web: { owns: ['web/'] } } });
  const added = await box.local('add', 'web', 'Held refusal control', '--criterion', 'Do not edit a claimed item', '--json');
  assert.equal(added.status, 0, added.stderr || added.stdout);
  const id = JSON.parse(added.stdout).item.item_id;
  const created = await box.local('worktree', 'web', '--json');
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const agent = JSON.parse(created.stdout);
  const claim = await runCliInProcess(['claim', String(id), '--json'], { cwd: agent.path, env: box.env });
  assert.equal(claim.status, 0, claim.stderr || claim.stdout);
  const text = await box.local('edit', String(id), '--route', 'mid');
  const json = await box.local('edit', String(id), '--route', 'mid', '--json');
  assert.equal(text.status, 1);
  assert.equal(json.status, 1);
  const refusal = JSON.parse(json.stdout).error;
  assert.equal(refusal.code, 'HELD');
  assert.ok(text.stderr.trimEnd().endsWith(`next: ${refusal.next}`), text.stderr);
});

test('text USAGE refusal ends with the same next step as JSON [L3]', async () => {
  const box = await boardBox();
  const text = await box.local('status', '--not-a-real-flag');
  const json = await box.local('status', '--not-a-real-flag', '--json');
  assert.equal(text.status, 2);
  assert.equal(json.status, 2);
  const refusal = JSON.parse(json.stdout).error;
  assert.equal(refusal.code, 'USAGE');
  assert.ok(text.stderr.trimEnd().endsWith(`next: ${refusal.next}`), text.stderr);
});

test('commands and doctor explain how to repair core.bare without crossing a nested repo [A6, P4]', async () => {
  const box = await boardBox({ repoName: "O'Brien project" });
  const root = box.git('rev-parse', '--show-toplevel');
  const gitDir = `'${join(root, '.git').replaceAll("'", "'\\''")}'`;
  const repair = `git --git-dir=${gitDir} config core.bare false`;
  box.git('config', 'core.bare', 'true');

  const command = await box.local('status');
  assert.equal(command.status, 1);
  assert.match(command.stderr, /\[CORE_BARE\].*core\.bare=true.*working files are present beside \.git/u);
  assert.ok(command.stderr.includes(repair), command.stderr);
  const refusal = await box.local('status', '--json');
  assert.equal(refusal.status, 1);
  assert.equal(JSON.parse(refusal.stdout).error.next, `run ${repair}`);

  const doctor = await box.local('doctor', '--json');
  assert.equal(doctor.status, 1);
  assert.equal(doctor.stderr, '');
  const document = JSON.parse(doctor.stdout);
  assert.equal(document.version, 1);
  assert.deepEqual(document.problems, [{
    code: 'CORE_BARE',
    message: `main checkout ${root} has .git/config core.bare=true while working files are present beside .git`,
    next: repair,
  }]);

  const nested = join(box.root, 'nested');
  mkdirSync(nested);
  const nestedGitInit = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: nested, env: box.env, encoding: 'utf8' });
  assert.equal(nestedGitInit.status, 0, nestedGitInit.failure);
  /** Run the private Pullboard CLI from the nested repo under the bare parent. */
  const nestedRun = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: nested, env: box.env, encoding: 'utf8' });
  const nestedInit = nestedRun('init');
  assert.equal(nestedInit.status, 0, nestedInit.stderr);
  const nestedStatus = nestedRun('status');
  assert.equal(nestedStatus.status, 0, nestedStatus.stderr);
  const nestedDoctor = nestedRun('doctor');
  assert.equal(nestedDoctor.status, 0, nestedDoctor.stderr);

  const repaired = runFixtureChild('sh', ['-c', repair], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(repaired.status, 0, repaired.failure);
  assert.equal((await box.local('status')).status, 0);
  assert.equal((await box.local('doctor')).status, 0);
});

test('doctor finds a missing lifecycle trigger without reinstalling it [A6]', async () => {
  const box = await boardBox();
  mutate(box, (db) => db.exec('DROP TRIGGER machine_item_start'));
  const result = await box.local('doctor');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /machine_item_start is missing; repair: run pullboard status/);
  const db = new DatabaseSync(box.dbFile, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='machine_item_start'").get().n, 0);
  } finally {
    db.close();
  }
});

test('doctor reports every required field missing from an item state [A6]', async () => {
  const box = await boardBox();
  const id = addItem(box);
  mutate(box, (db) => {
    db.exec('DROP TRIGGER machine_item_move; DROP TRIGGER machine_fields_claimed');
    db.prepare("UPDATE item SET item_status='claimed', item_owner='', item_lease_until='', item_frozen_digest='' WHERE item_id=?").run(id);
  });
  const result = await box.local('doctor');
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`item #${id} \\(claimed\\) is missing item_owner, item_lease_until, item_frozen_digest`));
  assert.match(result.stdout, /restore a consistent board backup, then run pullboard doctor/);
});

test('doctor reports a submitted item whose git pin is gone [A6]', async () => {
  const box = await boardBox();
  const id = addItem(box);
  const verifiedId = addItem(box);
  writeFileSync(join(box.root, 'proof.txt'), 'commit for the submitted item\n');
  box.git('add', '-A');
  box.git('commit', '-q', '-m', 'docs: make a fixture commit');
  const commit = box.git('rev-parse', 'HEAD');
  mutate(box, (db) => {
    db.exec('DROP TRIGGER machine_item_move; DROP TRIGGER machine_fields_submitted; DROP TRIGGER machine_fields_verified; DROP TRIGGER machine_proof_verified');
    db.prepare("UPDATE item SET item_status='submitted', item_built_by='web-1', item_commit=?, item_frozen_digest='fixture-digest' WHERE item_id=?").run(commit, id);
    db.prepare("UPDATE item SET item_status='verified', item_verified_by='review-1', item_commit=? WHERE item_id=?").run(commit, verifiedId);
  });
  const result = await box.local('doctor');
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`item #${id} has no pin for ${commit}`));
  assert.match(result.stdout, new RegExp(`git update-ref refs/pullboard/items/${id}/${commit.slice(0, 12)} ${commit}`));
  assert.match(result.stdout, new RegExp(`item #${verifiedId} has no pin for ${commit}`));
});

test('doctor reports verdicts whose commit object is gone [A6]', async () => {
  const box = await boardBox();
  const id = addItem(box);
  const missing = 'f'.repeat(40);
  mutate(box, (db) => {
    db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note,
      verdict_commit, verdict_digest, verdict_head, verdict_at) VALUES (?, 'review-1', 'REJECT', 'OTHER', 'fixture', ?, 'digest', 'head', '2026-10-07T00:00:00.000Z')`)
      .run(id, missing);
  });
  const result = await box.local('doctor');
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`verdict #1 for item #${id} names missing commit ${missing}`));
  assert.match(result.stdout, new RegExp(`git update-ref refs/pullboard/items/${id}/${missing.slice(0, 12)} ${missing}`));
});

test('doctor reports older and newer schema versions without migrating either [A6]', async () => {
  const box = await boardBox();
  mutate(box, (db) => db.exec('PRAGMA user_version = 0'));
  const older = runRelease(box, 'doctor');
  assert.equal(older.status, 1);
  assert.match(older.stdout, new RegExp(`schema version is 0; this pullboard expects ${SCHEMA_VERSION}; repair: run pullboard status to upgrade this board`));
  mutate(box, (db) => db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`));
  const newer = await box.local('doctor');
  assert.equal(newer.status, 1);
  assert.match(newer.stdout, new RegExp(`schema version is ${SCHEMA_VERSION + 1}; this pullboard expects ${SCHEMA_VERSION}; repair: use a pullboard version that supports this board schema`));
  const db = new DatabaseSync(box.dbFile, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION + 1);
  } finally {
    db.close();
  }
});

test('doctor reports an older empty SQLite layout without querying current tables [A6]', async () => {
  const box = await boardBox({ initialize: false });
  const db = new DatabaseSync(box.dbFile);
  db.exec('PRAGMA user_version = 0');
  db.close();
  const before = readFileSync(box.dbFile);
  const result = runRelease(box, 'doctor');
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`schema version is 0; this pullboard expects ${SCHEMA_VERSION}; repair: run pullboard status to upgrade this board`));
  assert.doesNotMatch(result.stderr, /no such table|SQLITE_ERROR|Error:/);
  assert.deepEqual(readFileSync(box.dbFile), before);
});

test('doctor reports missing triggers on a current empty layout without changing it [A6]', async () => {
  const box = await boardBox({ initialize: false });
  const db = new DatabaseSync(box.dbFile);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  db.close();
  const before = readFileSync(box.dbFile);
  for (const flags of [[], ['--json']]) {
    const result = await box.local('doctor', ...flags);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    if (flags.length) {
      const document = JSON.parse(result.stdout);
      assert.equal(document.version, 1);
      assert.ok(document.problems.some((problem) => problem.code === 'TRIGGER_MISSING' && problem.message.includes('machine_item_start') && problem.next === 'run pullboard status'));
      assert.ok(document.problems.some((problem) => problem.code === 'TABLE_MISSING' && problem.message.includes('item') && problem.next.includes('pullboard status')));
    } else {
      assert.match(result.stdout, /machine_item_start is missing; repair: run pullboard status/);
      assert.doesNotMatch(result.stdout, /no such table|Error:/);
    }
    assert.deepEqual(readFileSync(box.dbFile), before);
  }
});
