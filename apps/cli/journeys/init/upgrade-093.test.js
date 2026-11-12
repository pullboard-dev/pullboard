/** A plain project board made by 0.9.3 opens under 0.9.4, keeps every status, and its claimed item submits with a settling gate [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { watch } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { closeBoard } from '../../../lib/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { openKitBoard } from '../../tests/fixtures/testkit.js';

// The fixture is a whole plain project made by the v0.9.3 release (git archive of its tag, run as a process): init, a
// web lane, `gate set true`, then item 1 built, verified by another seat and merged, item 2 claimed by web-1, item 3 open.
const FIXTURE = join(import.meta.dirname, '../../../../packages/state/tests/fixtures/board-093.tgz');
const MADE_AT = '/private/tmp/claude-501/b93/proj';

/** Unpack the 0.9.3 project into the sandbox and point its board and worktrees at the new place. */
function unpack(box) {
  const unpacked = spawnSync('tar', ['-xzf', FIXTURE, '-C', box.dir], { encoding: 'utf8' });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  const repo = join(box.dir, 'proj');
  box.git(repo, 'worktree', 'repair', join(repo, '.claude', 'worktrees', 'web-1'), join(repo, '.claude', 'worktrees', 'review-1'));
  // @pullboard-board-file journey: the board is a 0.9.3 file; its seat paths move with the project, and the claim's two-hour lease, long over, is renewed.
  const db = new DatabaseSync(join(repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    db.prepare('UPDATE agent SET agent_path = replace(agent_path, ?, ?)').run(MADE_AT, repo);
    db.prepare("UPDATE item SET item_lease_until = '2099-01-01T00:00:00.000Z' WHERE item_status = 'claimed'").run();
  } finally { db.close(); }
  return repo;
}

/**
 * Open the board as 0.9.4's own install does on its first command (the owner of a shared board migrates it) and close it.
 * Why a copy outside the repository layout: a test runs the code from a worktree, which is never a shared board's owner,
 * so only a private copy opens as owner; the migrated file then takes the board's place.
 */
function migrate(box, repo) {
  const file = join(repo, '.git', 'pullboard', 'board.sqlite');
  const folder = join(box.dir, 'migrating');
  mkdirSync(folder);
  const copy = join(folder, 'board.sqlite');
  copyFileSync(file, copy);
  closeBoard(openKitBoard(copy, undefined, { isMain: true }));
  for (const sidecar of ['-wal', '-shm']) rmSync(`${file}${sidecar}`, { force: true });
  copyFileSync(copy, file);
}

/** The first line of `show` for one item, as the person reads it. */
async function line(box, cwd, id) {
  const shown = await box.inProcess(cwd, 'show', String(id));
  assert.equal(shown.code, 0, shown.err);
  return shown.out.split('\n')[0];
}

/** Wait until `show` prints the stage in parentheses, probed again whenever the local runner's folder changes. */
function stageOf(box, cwd, id, stage) {
  return new Promise((done, fail) => {
    let watcher = null;
    let probing = false;
    let again = false;
    const probe = async () => {
      if (probing) { again = true; return; }
      probing = true;
      try {
        do {
          again = false;
          const text = await line(box, cwd, id);
          if (text.includes(`(${stage})`)) { watcher?.close(); done(text); return; }
        } while (again);
      } catch (error) { watcher?.close(); fail(error); }
      probing = false;
    };
    watcher = watch(join(box.env.PULLBOARD_MACHINE_HOME, 'local-runner'), probe);
    probe();
  });
}

test('clause 1: a 0.9.3 board with open, claimed and landed items opens under 0.9.4, migrates and keeps every status [C7]', { timeout: 120_000 }, // budget: hang ceiling for unpacking, one migration and a few reads.
async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox();
  const repo = unpack(box);
  const file = join(repo, '.git', 'pullboard', 'board.sqlite');
  migrate(box, repo);
  // @pullboard-board-file journey: reads the migrated 0.9.3 file's tables to prove the 0.9.4 job tables arrived.
  const db = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('job', 'job_step')").get().n, 2, 'the job tables are installed'); } finally { db.close(); }
  assert.match(await line(box, repo, 1), /^#1 {2}verified \(landed\)/u);
  assert.match(await line(box, repo, 2), /^#2 {2}claimed web-1 .*\(building\)/u);
  assert.match(await line(box, repo, 3), /^#3 {2}open /u);
});

test('clause 2: the claimed 0.9.3 item submits under 0.9.4 on default settings and its gate settles [C7]', { timeout: 240_000 }, // budget: hang ceiling for one local runner start and one pulled gate.
async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox();
  const repo = unpack(box);
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { localLoadShare: 1000 } });
  migrate(box, repo);
  const seat = join(repo, '.claude', 'worktrees', 'web-1');
  mkdirSync(join(seat, 'src'), { recursive: true });
  writeFileSync(join(seat, 'src', 'claimed.txt'), 'built under 0.9.3, submitted under 0.9.4\n');
  box.git(seat, 'add', '-A');
  assert.equal(box.tryGit(seat, 'commit', '-q', '-m', 'feat(web): claimed item [G1]').status, 0);
  const submitted = await box.inProcess(seat, 'submit', '2');
  assert.equal(submitted.code, 0, `${submitted.err}${submitted.out}`);
  const pid = /local runner \(pid (\d+)\)/u.exec(submitted.out)?.[1];
  t.after(() => { try { if (pid) process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ } });
  assert.match(await stageOf(box, seat, 2, 'in review'), /\(in review\)/u);
  assert.match(await line(box, repo, 1), /\(landed\)/u, 'the landed item still reads landed');
  assert.match(await line(box, repo, 3), /^#3 {2}open /u, 'the open item is still open');
});
