/** Approved row edits identify every affected frozen item without rewriting receipts [S19,V3]. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AGENT_SHELL_MARKERS, SSH_SHELL_MARKERS } from '../src/person.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const TEMP_DIRS = [];
const OLD_SPEC = `# Stale frozen fixture

## G · Goals
- G1 [approved, must] The current promise. | gate: true
- G3 [approved, must] An unaffected promise. | gate: true
`;
const NEW_TEXT = 'The person approved this exact updated promise.';

/** Remove each private repo, board and home created by this file. */
function cleanup() {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
}

after(cleanup);

/** Quote one shell argument for the fixture's private hook executable. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Build a private real-Git project with an initialized board, active hooks and a web worktree. */
function project(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-stale-frozen-'));
  TEMP_DIRS.push(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const web = join(dir, 'web');
  const bin = join(dir, 'bin');
  mkdirSync(root);
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') || AGENT_SHELL_MARKERS.includes(name) || SSH_SHELL_MARKERS.includes(name)) delete env[name];
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(dir, 'home'),
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  /** Run the real Pullboard CLI in one fixture checkout; the test runner owns the hang bound. */
  function pullboard(cwd, ...args) {
    return runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  }
  /** Run real Git with isolated identity while preserving hook-provided index variables. */
  function git(cwd, ...args) {
    return runFixtureGit(args, { cwd, env });
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Stale-frozen fixture');
  git(root, 'config', 'user.email', 'stale-frozen@example.invalid');
  const initialized = pullboard(root, 'init');
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  writeFileSync(join(root, 'pullboard.json'), `${JSON.stringify({
    gate: 'true', spec: 'SPEC.md', verify: 'coordinator', lease: '2h',
    lanes: { web: { owns: ['web/'], specs: ['G1', 'G3'] } }, shared: [],
  }, null, 2)}\n`);
  writeFileSync(join(root, 'SPEC.md'), OLD_SPEC);
  mkdirSync(join(root, 'web'));
  git(root, 'add', '-A');
  const initial = runFixtureChild('git', ['commit', '-q', '-m', 'chore: initialize stale-frozen fixture'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(initial.status, 0, `${initial.stdout}${initial.stderr}`);
  git(root, 'worktree', 'add', '-q', web, '-b', 'web/stale-frozen');
  const joined = pullboard(web, 'join', 'web');
  assert.equal(joined.status, 0, `${joined.stdout}${joined.stderr}`);
  return { dir, root, web, env, git, pullboard };
}

/** Create a real item that cites one frozen row and return its persisted id. */
function addItem(box, title, specId = 'G1') {
  const result = box.pullboard(box.root, 'add', 'web', title, '--criterion', `Check ${title}.`, '--specs', specId, '--json');
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout).item.item_id;
}

/** Run a CLI command and require its successful result. */
function succeeds(box, cwd, ...args) {
  const result = box.pullboard(cwd, ...args);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result;
}

/** Freeze an item's cited text by claiming it in the real agent worktree. */
function claim(box, id) {
  succeeds(box, box.web, 'claim', String(id));
}

/** Make, submit and return a real lane commit for an item. */
function submit(box, id, name) {
  claim(box, id);
  const relative = `web/${name}.txt`;
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, relative), `${name}\n`);
  box.git(box.web, 'add', relative);
  const committed = runFixtureChild('git', ['commit', '-m', `feat(web): build ${name} [G1]`], { cwd: box.web, env: box.env, encoding: 'utf8' });
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`);
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  succeeds(box, box.web, 'submit', String(id));
  return head;
}

/** Verify a submitted private fixture commit as the coordinator without touching any real board. */
function accept(box, id, commit) {
  box.git(box.root, 'switch', '--detach', commit);
  succeeds(box, box.root, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'checked the private fixture commit');
  box.git(box.root, 'switch', 'main');
}

/** Read item and verdict receipts without opening or migrating the board. */
function receiptSnapshot(box) {
  const common = box.git(box.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const file = join(common, 'pullboard', 'board.sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      items: db.prepare('SELECT item_id, item_status, item_frozen, item_frozen_digest, item_verdict, item_commit, item_merged_commit FROM item ORDER BY item_id').all(),
      verdicts: db.prepare('SELECT * FROM verdict ORDER BY verdict_id').all(),
    };
  } finally { db.close(); }
}

/** Read the underlying SQLite bytes to prove doctor did not repair or rewrite board evidence. */
function boardBytes(box) {
  const common = box.git(box.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  return readFileSync(join(common, 'pullboard', 'board.sqlite'));
}

test('[S19,V3] doctor and resume list stale frozen items in every lifecycle state without rewriting evidence', { timeout: 120_000 }, (t) => {
  const box = project(t);
  const ids = {};

  ids.open = addItem(box, 'Open stale item');
  claim(box, ids.open);
  succeeds(box, box.web, 'release', String(ids.open));

  ids.submitted = addItem(box, 'Submitted stale item');
  submit(box, ids.submitted, 'submitted');

  ids.verified = addItem(box, 'Verified stale item');
  const verifiedCommit = submit(box, ids.verified, 'verified');
  accept(box, ids.verified, verifiedCommit);

  ids.merged = addItem(box, 'Merged stale item');
  const mergedCommit = submit(box, ids.merged, 'merged');
  accept(box, ids.merged, mergedCommit);
  box.git(box.root, 'merge', '--no-edit', mergedCommit);
  succeeds(box, box.root, 'merged', String(ids.merged), box.git(box.root, 'rev-parse', 'HEAD'));

  ids.withdrawn = addItem(box, 'Withdrawn stale item');
  claim(box, ids.withdrawn);
  succeeds(box, box.web, 'release', String(ids.withdrawn));
  succeeds(box, box.root, 'withdraw', String(ids.withdrawn), 'no longer needed');

  ids.unaffected = addItem(box, 'Unaffected G3 item', 'G3');
  claim(box, ids.unaffected);
  succeeds(box, box.web, 'release', String(ids.unaffected));

  ids.claimed = addItem(box, 'Claimed stale item');
  claim(box, ids.claimed);

  const decision = box.pullboard(box.root, 'spec', 'approve', 'G1', '--text', NEW_TEXT, '--json');
  assert.equal(decision.status, 0, `${decision.stdout}${decision.stderr}`);
  succeeds(box, box.root, 'spec', 'apply', '--json');
  box.git(box.root, 'add', 'SPEC.md');
  const appliedCommit = runFixtureChild('git', ['commit', '-m', 'docs: update approved G1 wording [G1]'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(appliedCommit.status, 0, `${appliedCommit.stdout}${appliedCommit.stderr}`);
  assert.ok(readFileSync(join(box.root, 'SPEC.md'), 'utf8').includes(NEW_TEXT));

  const expected = [ids.open, ids.claimed, ids.submitted, ids.verified, ids.merged, ids.withdrawn].sort((a, b) => a - b);
  const statuses = new Map([
    [ids.open, 'open'], [ids.claimed, 'claimed'], [ids.submitted, 'submitted'],
    [ids.verified, 'verified'], [ids.merged, 'verified'], [ids.withdrawn, 'withdrawn'],
  ]);
  const before = receiptSnapshot(box);
  const bytesBeforeDoctor = boardBytes(box);

  const doctorJson = box.pullboard(box.root, 'doctor', '--json');
  assert.notEqual(doctorJson.status, 0, doctorJson.stderr || doctorJson.stdout);
  const doctorDocument = JSON.parse(doctorJson.stdout);
  const findings = doctorDocument.problems.filter((problem) => problem.code === 'STALE_ITEM');
  assert.deepEqual(findings.map((finding) => Number(/item #(\d+)/u.exec(finding.message)?.[1])).sort((a, b) => a - b), expected);
  for (const finding of findings) {
    const id = Number(/item #(\d+)/u.exec(finding.message)?.[1]);
    if (['open', 'claimed', 'submitted'].includes(statuses.get(id))) assert.match(finding.next, new RegExp(`pullboard refreeze ${id}\\b`));
    else if (['verified', 'merged'].includes(statuses.get(id))) {
      assert.match(finding.message, new RegExp(`item #${id} shipped against the old text of G1`));
      assert.match(finding.next, /pullboard add web .*--specs G1/u);
    }
  }
  assert.deepEqual(boardBytes(box), bytesBeforeDoctor, 'doctor did not write or migrate any board bytes');

  const doctorText = box.pullboard(box.root, 'doctor');
  assert.equal(doctorText.status, 1, doctorText.stderr || doctorText.stdout);
  for (const id of expected) assert.match(doctorText.stdout, new RegExp(`item #${id}\\b`));
  const afterResumeBaseline = receiptSnapshot(box);
  const resumeJson = succeeds(box, box.root, 'resume', '--json');
  const resumeDocument = JSON.parse(resumeJson.stdout);
  assert.deepEqual(resumeDocument.stale.map((item) => item.id).sort((a, b) => a - b), expected);
  for (const item of resumeDocument.stale) {
    if (['open', 'claimed', 'submitted'].includes(item.status)) assert.match(item.next, new RegExp(`pullboard refreeze ${item.id}\\b`));
    else if (['verified', 'merged'].includes(item.status)) {
      assert.match(item.message, new RegExp(`item #${item.id} shipped against the old text of G1`));
      assert.match(item.next, /pullboard add web .*--specs G1/u);
    }
  }
  const resumeText = succeeds(box, box.root, 'resume');
  assert.match(resumeText.stdout, new RegExp(`${expected.length} stale follow-ups; list them with pullboard resume --json`));
  assert.equal((resumeText.stdout.match(/^stale:/gmu) ?? []).length, 0, 'the coordinator sees one counted line, with details in JSON');
  assert.equal(resumeDocument.staleFollowUps.count, expected.length);
  assert.equal(resumeDocument.staleFollowUps.list, 'pullboard resume --json');
  assert.deepEqual(resumeDocument.staleFollowUps.items.map((item) => item.id).sort((a, b) => a - b), expected,
    'the named listing retains every stale item across every lifecycle state');
  assert.deepEqual(receiptSnapshot(box), afterResumeBaseline, 'resume leaves frozen fields, merge receipts and accepted verdicts unchanged');
  assert.deepEqual(receiptSnapshot(box), before, 'diagnostics do not alter accepted receipts or frozen bars');
  assert.ok(!findings.some((finding) => finding.message.includes(`item #${ids.unaffected} `)), 'the item frozen on G3 remains unaffected');
  succeeds(box, box.root, 'refreeze', String(ids.open));
  const afterRefreeze = JSON.parse(succeeds(box, box.root, 'resume', '--json').stdout);
  assert.deepEqual(afterRefreeze.stale.map((item) => item.id).sort((a, b) => a - b), expected.filter((id) => id !== ids.open), 'explicit refreeze clears only the active item repaired against new text');
  const historical = (snapshot) => snapshot.items.filter((item) => item.item_status === 'verified');
  assert.deepEqual(historical(receiptSnapshot(box)), historical(before), 'refreezing active work preserves every accepted historical receipt');
});


test('[A5,S19,V3] doctor and resume distinguish unchanged doctrine citations from changed doctrine text', (t) => {
  const box = project(t);
  const doctrineItem = addItem(box, 'Doctrine citation', 'doctrine:PB1');
  claim(box, doctrineItem);
  succeeds(box, box.web, 'release', String(doctrineItem));
  const specItem = addItem(box, 'Unchanged spec citation', 'G3');
  claim(box, specItem);
  succeeds(box, box.web, 'release', String(specItem));
  const baseline = receiptSnapshot(box);
  const before = JSON.parse(succeeds(box, box.root, 'resume', '--json').stdout);
  assert.deepEqual(before.stale, [], 'a namespaced citation with unchanged inherited text is current');
  const doctorBefore = JSON.parse(box.pullboard(box.root, 'doctor', '--json').stdout);
  assert.deepEqual(doctorBefore.problems.filter(problem => problem.code === 'STALE_ITEM'), []);
  const path = join(box.root, 'DOCTRINE.md');
  writeFileSync(path, readFileSync(path, 'utf8') + '\n## Local override\n- PB1 [approved, must] Updated inherited rule. | gate: true\n');
  const after = JSON.parse(succeeds(box, box.root, 'resume', '--json').stdout);
  assert.deepEqual(after.stale.map(item => [item.id, item.rows]), [[doctrineItem, ['doctrine:PB1']]]);
  const doctorAfter = JSON.parse(box.pullboard(box.root, 'doctor', '--json').stdout);
  const findings = doctorAfter.problems.filter(problem => problem.code === 'STALE_ITEM');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /old text of doctrine:PB1/);
  assert.deepEqual(receiptSnapshot(box), baseline, 'diagnostics preserve frozen evidence and unrelated SPEC citations');
});
