/** A linked worktree never prints the maintenance timer warning; a main checkout reports a real failure [B3,C7,#2909]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveMaintenanceWorktree } from '../../../../src/io/worktree/maintenance/archive.js';
import { maintenanceArchiveMatches } from '../../../../src/io/worktree/maintenance/archive.js';
import { archiveVolume } from '../../../../src/io/worktree/maintenance/archive.js';
import { maintenanceGit } from '../../../../src/io/worktree/maintenance/archive.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { scheduleWorktreeMaintenance } from '../../../../src/io/worktree/maintenance/scheduler.js';

/** A primary checkout with maintenance enabled, a stub timer binary and one linked worktree. */
function repository(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pullboard-timer-quiet-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = join(root, 'primary'), linked = join(root, 'linked');
  fs.mkdirSync(join(primary, 'apps/cli'), { recursive: true });
  maintenanceGit(primary, ['init', '-q', '-b', 'main']);
  maintenanceGit(primary, ['config', 'user.name', 'Timer Fixture']);
  maintenanceGit(primary, ['config', 'user.email', 'timer@example.invalid']);
  fs.writeFileSync(join(primary, 'pullboard.json'), JSON.stringify({ worktreeMaintenance: { enabled: true } }));
  fs.writeFileSync(join(primary, 'apps/cli/pullboard.js'), 'setTimeout(() => {}, 4000);\n');
  maintenanceGit(primary, ['add', '.']); maintenanceGit(primary, ['commit', '-qm', 'timer fixture']);
  maintenanceGit(primary, ['worktree', 'add', '-q', '--detach', linked]);
  const commonDir = fs.realpathSync(maintenanceGit(primary, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  const config = { worktreeMaintenance: { enabled: true } };
  t.after(() => {
    try { process.kill(JSON.parse(fs.readFileSync(join(commonDir, 'pullboard', 'worktree-maintenance', 'timer.json'), 'utf8')).pid); }
    catch { /* No timer was registered. */ }
  });
  return { primary: { info: { root: fs.realpathSync(primary), commonDir, isMain: true }, config },
    linked: { info: { root: fs.realpathSync(linked), commonDir, isMain: false }, config }, commonDir };
}

/** Exercise scheduler behavior outside runner jobs, whose production policy intentionally skips detached timers. */
async function withoutRunnerJob(work) {
  const saved = process.env.PULLBOARD_RUNNER_JOB;
  delete process.env.PULLBOARD_RUNNER_JOB;
  try { return await work(); }
  finally { if (saved === undefined) delete process.env.PULLBOARD_RUNNER_JOB; else process.env.PULLBOARD_RUNNER_JOB = saved; }
}

test('cli.io-worktree-maintenance-archive.a-linked-worktree-with-an-inherited-git: clause 1: a linked worktree with an inherited GIT_DIR still registers the timer without an error [B3,C7]', async t => {
  await withoutRunnerJob(async () => {
    const { linked } = repository(t), saved = process.env.GIT_DIR;
    process.env.GIT_DIR = maintenanceGit(linked.info.root, ['rev-parse', '--absolute-git-dir']).trim();
    try {
      const result = await scheduleWorktreeMaintenance(linked);
      assert.equal(result.scheduled, true, 'the primary checkout is still found as the primary');
    } finally { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; }
  });
});

test('cli.io-worktree-maintenance-archive.a-linked-worktree-skips-quietly-when-the: clause 1: a linked worktree skips quietly when the repository identity cannot be proved [B3,C7]', async t => {
  await withoutRunnerJob(async () => {
    const { linked, commonDir } = repository(t);
    linked.info = { ...linked.info, commonDir: join(commonDir, 'elsewhere') };
    fs.mkdirSync(linked.info.commonDir);
    assert.deepEqual(await scheduleWorktreeMaintenance(linked), { scheduled: false, reason: 'linked-worktree-unavailable' });
  });
});

test('cli.io-worktree-maintenance-archive.a-real-registration-failure-in-the-main: clause 2: a real registration failure in the main checkout is still thrown once [B3,C7]', async t => {
  await withoutRunnerJob(async () => {
    const { primary, commonDir } = repository(t);
    primary.info = { ...primary.info, commonDir: join(commonDir, 'elsewhere') };
    fs.mkdirSync(primary.info.commonDir);
    await assert.rejects(() => scheduleWorktreeMaintenance(primary), error => error.maintenanceStage === 'lookup' && /repository changed/u.test(error.message));
  });
});

/** Fake statfs that records the path it was asked about. */
function fakeStatfs(seen, free = 100) {
  return path => { seen.push(path); return { bavail: free, bsize: 1, blocks: 1000 }; };
}

test('cli.io-worktree-maintenance-archive.the-space-check-measures-the-volume-a: clause 1: the space check measures the volume a symlinked archive directory points to [C7,#5444]', t => {
  const root = privateFixtureFiles('pullboard-archive-volume-').root;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const common = join(root, 'git'), elsewhere = join(root, 'elsewhere');
  fs.mkdirSync(join(common, 'pullboard'), { recursive: true });
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, join(common, 'pullboard', 'worktree-archives'));
  const seen = [];
  const space = archiveVolume(common, fakeStatfs(seen, 777));
  assert.deepEqual(seen, [elsewhere]);
  assert.equal(space.freeBytes, 777);
  assert.equal(space.totalBytes, 1000);
});

test('cli.io-worktree-maintenance-archive.without-a-symlink-the-space-check-measures: clause 1: without a symlink the space check measures the archive directory or its nearest parent [C7,#5444]', t => {
  const root = privateFixtureFiles('pullboard-archive-volume-').root;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const common = join(root, 'git');
  fs.mkdirSync(common);
  const seen = [];
  archiveVolume(common, fakeStatfs(seen));
  fs.mkdirSync(join(common, 'pullboard', 'worktree-archives'), { recursive: true });
  archiveVolume(common, fakeStatfs(seen));
  assert.deepEqual(seen, [common, join(common, 'pullboard', 'worktree-archives')]);
});

test('cli.io-worktree-maintenance-archive.a-short-archive-volume-still-refuses-and: clause 1: a short archive volume still refuses and an unreadable one refuses as unknown [C7,#5444]', t => {
  const root = privateFixtureFiles('pullboard-archive-volume-').root;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  fs.mkdirSync(repo);
  maintenanceGit(repo, ['init', '-q', '-b', 'main']);
  maintenanceGit(repo, ['config', 'user.name', 'Archive Fixture']);
  maintenanceGit(repo, ['config', 'user.email', 'archive@example.invalid']);
  fs.writeFileSync(join(repo, 'a.txt'), 'a\n');
  maintenanceGit(repo, ['add', '.']); maintenanceGit(repo, ['commit', '-qm', 'fixture']);
  fs.writeFileSync(join(repo, 'dirty.txt'), 'dirty\n');
  const common = fs.realpathSync(join(repo, '.git'));
  const short = () => ({ freeBytes: 1024, totalBytes: 1024 ** 4 });
  assert.throws(() => archiveMaintenanceWorktree(repo, common, { volume: short }), /ARCHIVE_WOULD_FILL_DISK.*free/);
  assert.throws(() => archiveMaintenanceWorktree(repo, common, { volume: () => { throw new Error('no statfs'); } }),
    /ARCHIVE_WOULD_FILL_DISK.*unknown/);
});

/** A dirty repository whose archive folder is a symlink to a directory with the given mode. */
function symlinkedArchive(t, mode) {
  const root = privateFixtureFiles('pullboard-archive-link-').root;
  const repo = join(root, 'repo'), target = join(root, 'target');
  fs.mkdirSync(repo);
  fs.mkdirSync(target, { mode });
  fs.chmodSync(target, mode);
  maintenanceGit(repo, ['init', '-q', '-b', 'main']);
  maintenanceGit(repo, ['config', 'user.name', 'Archive Fixture']);
  maintenanceGit(repo, ['config', 'user.email', 'archive@example.invalid']);
  fs.writeFileSync(join(repo, 'a.txt'), 'a\n');
  maintenanceGit(repo, ['add', '.']); maintenanceGit(repo, ['commit', '-qm', 'fixture']);
  fs.writeFileSync(join(repo, 'dirty.txt'), 'dirty\n');
  const common = fs.realpathSync(join(repo, '.git'));
  fs.mkdirSync(join(common, 'pullboard'));
  fs.symlinkSync(target, join(common, 'pullboard', 'worktree-archives'));
  return { repo, common, target };
}
const roomy = () => ({ freeBytes: 1024 ** 4, totalBytes: 1024 ** 4 });

test('cli.io-worktree-maintenance-archive.a-symlinked-archive-folder-with-a-private: clause 1: a symlinked archive folder with a private target of the user is archived into and matches [C7,#5445]', t => {
  const { repo, common, target } = symlinkedArchive(t, 0o700);
  const archive = archiveMaintenanceWorktree(repo, common, { volume: roomy });
  assert.ok(fs.existsSync(join(target, archive.manifest.id, 'manifest.json')));
  assert.equal(maintenanceArchiveMatches(repo, archive), true);
});

test('cli.io-worktree-maintenance-archive.a-symlinked-archive-folder-whose-target-is: clause 1: a symlinked archive folder whose target is not private is refused [C7,#5445]', t => {
  const { repo, common } = symlinkedArchive(t, 0o755);
  assert.throws(() => archiveMaintenanceWorktree(repo, common, { volume: roomy }), /not private/);
});

test('cli.io-worktree-maintenance-archive.a-symlinked-archive-folder-whose-target-another: clause 1: a symlinked archive folder whose target another user owns is refused [C7,#5445]', t => {
  const { repo, common } = symlinkedArchive(t, 0o700);
  const saved = process.getuid;
  process.getuid = () => saved.call(process) + 1;
  t.after(() => { process.getuid = saved; });
  assert.throws(() => archiveMaintenanceWorktree(repo, common, { volume: roomy }), /not private/);
});

/** An archive whose files read back with the modes and times a network share reports [C7,#5454]. */
function shareArchive(t) {
  const { repo, common, target } = symlinkedArchive(t, 0o700);
  const archive = archiveMaintenanceWorktree(repo, common, { volume: roomy });
  const directory = join(target, archive.manifest.id);
  const blob = join(directory, 'blobs', archive.manifest.files[0].sha256);
  return { repo, archive, directory, blob };
}

test('cli.io-worktree-maintenance-archive.an-archive-whose-files-read-back-with: clause 1: an archive whose files read back with share-mapped modes and times still verifies [C7,#5454]', t => {
  const { repo, archive, directory, blob } = shareArchive(t);
  for (const file of [blob, join(directory, 'manifest.json'), join(directory, 'staged.patch')]) {
    fs.chmodSync(file, 0o700);
    fs.utimesSync(file, new Date(1e12), new Date(1e12));
  }
  assert.equal(maintenanceArchiveMatches(repo, archive), true);
});

test('cli.io-worktree-maintenance-archive.a-changed-archived-file-of-the-same: clause 1: a changed archived file of the same size still fails verification [C7,#5454]', t => {
  const { repo, archive, blob } = shareArchive(t);
  const bytes = fs.readFileSync(blob);
  fs.writeFileSync(blob, Buffer.alloc(bytes.length, 0x78));
  assert.equal(maintenanceArchiveMatches(repo, archive), false);
});

test('cli.io-worktree-maintenance-archive.a-truncated-archived-file-still-fails-verification: clause 1: a truncated archived file still fails verification [C7,#5454]', t => {
  const { repo, archive, blob } = shareArchive(t);
  fs.truncateSync(blob, 1);
  assert.equal(maintenanceArchiveMatches(repo, archive), false);
});

test('cli.io-worktree-maintenance-archive.an-archive-root-that-others-can-read: clause 1: an archive root that others can read still fails verification [C7,#5454]', t => {
  const { repo, archive, directory } = shareArchive(t);
  fs.chmodSync(directory, 0o755);
  assert.equal(maintenanceArchiveMatches(repo, archive), false);
});
