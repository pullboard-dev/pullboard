/** @pullboard-test-loads apps/cli/src/io/worktree/maintenance/archive.js */
/** Exact private Git recovery fixtures; registered by the maintenance frozen check [B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveMaintenanceWorktree } from '../../../../src/io/worktree/maintenance/archive.js';
import { maintenanceArchiveMatches } from '../../../../src/io/worktree/maintenance/archive.js';
import { maintenanceGit } from '../../../../src/io/worktree/maintenance/archive.js';
import { maintenanceSnapshot } from '../../../../src/io/worktree/maintenance/archive.js';
import { removePartialArchives } from '../../../../src/io/worktree/maintenance/archive.js';

function project(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pullboard-archive-fixture-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo'); fs.mkdirSync(root);
  const git = (...args) => maintenanceGit(root, args);
  git('init', '-q'); git('config', 'user.name', 'Archive Fixture'); git('config', 'user.email', 'archive@example.invalid');
  fs.writeFileSync(join(root, '.gitignore'), 'ignored/\n');
  fs.writeFileSync(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 255]));
  git('add', '.'); git('commit', '-qm', 'fixture base');
  const common = fs.realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir').trim());
  return { root, common, directory, git };
}

/** Register only when the real frozen wrapper calls this component. */
export function registerMaintenanceArchiveTests() {
  test('prune archives retain literal linked Git metadata and evidence after the private worktree disappears [B3,C7]', t => {
    const box = project(t), root = join(box.directory, 'retired');
    assert.throws(() => archiveMaintenanceWorktree(box.root, box.common, { includeMetadata: true }), /linked worktree/u);
    box.git('worktree', 'add', '-q', '--detach', root, 'HEAD');
    const gitDir = fs.realpathSync(maintenanceGit(root, ['rev-parse', '--path-format=absolute', '--git-dir']).trim());
    const evidence = join(gitDir, 'evidence'); fs.mkdirSync(evidence);
    const raw = Buffer.from('private fixture raw evidence\n'), profile = Buffer.from('{"fixture":true,"passed":1}\n');
    fs.writeFileSync(join(evidence, 'raw.log'), raw); fs.writeFileSync(join(evidence, 'run.profile.json'), profile);
    fs.symlinkSync('evidence/raw.log', join(gitDir, 'evidence-link'));
    const index = fs.readFileSync(join(gitDir, 'index'));
    fs.writeFileSync(join(gitDir, 'HEAD.lock'), '');
    assert.throws(() => archiveMaintenanceWorktree(root, box.common, { includeMetadata: true }), /lock/u);
    fs.unlinkSync(join(gitDir, 'HEAD.lock'));
    const archive = archiveMaintenanceWorktree(root, box.common, { includeMetadata: true });
    assert.equal(archive.manifest.metadata.gitDir, gitDir);
    assert.equal(maintenanceArchiveMatches(root, archive), true);
    fs.appendFileSync(join(evidence, 'raw.log'), 'new bytes');
    assert.equal(maintenanceArchiveMatches(root, archive), false, 'a changed metadata log forbids prune');
    fs.writeFileSync(join(evidence, 'raw.log'), raw);
    assert.equal(maintenanceArchiveMatches(root, archive), true);
    const saved = path => {
      const file = archive.manifest.metadata.files.find(file => file.path === path);
      assert.ok(file, 'the complete linked Git directory includes ' + path);
      return fs.readFileSync(join(archive.directory, 'blobs', file.sha256));
    };
    assert.deepEqual(saved('index'), index);
    const indexFile = archive.manifest.metadata.files.find(file => file.path === 'index');
    const indexBlob = join(archive.directory, 'blobs', indexFile.sha256);
    fs.writeFileSync(indexBlob, 'corrupted');
    assert.equal(maintenanceArchiveMatches(root, archive), false, 'metadata blob integrity is required too');
    fs.writeFileSync(indexBlob, index);
    assert.equal(maintenanceArchiveMatches(root, archive), true);
    box.git('worktree', 'remove', '--force', root);
    assert.equal(fs.existsSync(gitDir), false, 'only this private fixture simulates removal');
    assert.deepEqual(saved('index'), index);
    assert.deepEqual(saved('evidence/raw.log'), raw);
    assert.deepEqual(saved('evidence/run.profile.json'), profile);
    assert.deepEqual(saved('evidence-link'), Buffer.from('evidence/raw.log'));
    assert.equal(box.git('rev-parse', archive.manifest.ref).trim(), archive.manifest.head);
    assert.equal(maintenanceArchiveMatches(root, archive), false, 'archive custody is retained without inventing a surviving source');
  });

  test('maintenance archive recovers separate staged and unstaged binary work plus all private leaves [B3,C7]', t => {
    const box = project(t), tracked = join(box.root, 'binary.dat');
    fs.writeFileSync(tracked, Buffer.from([0, 3, 4, 255])); box.git('add', 'binary.dat');
    fs.writeFileSync(tracked, Buffer.from([0, 5, 6, 255]));
    fs.mkdirSync(join(box.root, 'ignored'));
    fs.writeFileSync(join(box.root, 'ignored', 'saved.bin'), Buffer.alloc(3 * 1024 * 1024 + 19, 7));
    fs.writeFileSync(join(box.root, 'untracked.txt'), 'untracked bytes\n', { mode: 0o640 });
    fs.writeFileSync(join(box.directory, 'external.txt'), 'must never be followed');
    fs.symlinkSync('../external.txt', join(box.root, 'link'));
    const snapshot = maintenanceSnapshot(box.root);
    assert.ok(snapshot.dirty && Buffer.isBuffer(snapshot.stagedBuffer) && Buffer.isBuffer(snapshot.unstagedBuffer));
    assert.ok(snapshot.files.every(file => !Object.hasOwn(file, 'bytes')), 'snapshot metadata never retains regular file bodies');
    const archive = archiveMaintenanceWorktree(box.root, box.common);
    assert.equal(maintenanceArchiveMatches(box.root, archive), true);
    assert.equal(fs.statSync(archive.directory).mode & 0o777, 0o700);
    for (const file of ['manifest.json', 'staged.patch', 'unstaged.patch']) assert.equal(fs.statSync(join(archive.directory, file)).mode & 0o777, 0o600);
    assert.equal(box.git('rev-parse', archive.manifest.ref).trim(), snapshot.head);
    const recovered = join(box.directory, 'recovered');
    box.git('worktree', 'add', '-q', '--detach', recovered, archive.manifest.ref);
    maintenanceGit(recovered, ['apply', '--index', '--binary', join(archive.directory, 'staged.patch')]);
    maintenanceGit(recovered, ['apply', '--binary', join(archive.directory, 'unstaged.patch')]);
    for (const file of archive.manifest.files) {
      const path = join(recovered, file.path), bytes = fs.readFileSync(join(archive.directory, 'blobs', file.sha256));
      fs.mkdirSync(join(path, '..'), { recursive: true });
      if (file.type === 'symlink') {
        assert.deepEqual(bytes, Buffer.from(file.targetBase64, 'base64'));
        fs.symlinkSync(bytes, path);
      } else { fs.writeFileSync(path, bytes); fs.chmodSync(path, file.mode); }
    }
    assert.deepEqual(maintenanceGit(recovered, ['show', ':binary.dat'], { binary: true }), Buffer.from([0, 3, 4, 255]));
    assert.deepEqual(fs.readFileSync(join(recovered, 'binary.dat')), Buffer.from([0, 5, 6, 255]));
    assert.deepEqual(fs.readFileSync(join(recovered, 'ignored', 'saved.bin')), fs.readFileSync(join(box.root, 'ignored', 'saved.bin')));
    assert.equal(fs.readlinkSync(join(recovered, 'link')), '../external.txt');
    assert.equal(fs.statSync(join(recovered, 'untracked.txt')).mode & 0o777, 0o640);
    assert.equal(maintenanceSnapshot(box.root).signature, snapshot.signature, 'archiving never modifies source or index');
  });

  test('maintenance archive refuses changed source, missing pins and corrupted or symlinked archive bytes [B3,C7]', t => {
    const box = project(t), leaf = join(box.root, 'untracked.txt'); fs.writeFileSync(leaf, 'before');
    const archive = archiveMaintenanceWorktree(box.root, box.common);
    fs.writeFileSync(leaf, 'after'); assert.equal(maintenanceArchiveMatches(box.root, archive), false);
    fs.writeFileSync(leaf, 'before'); assert.equal(maintenanceArchiveMatches(box.root, archive), true);
    const blob = join(archive.directory, 'blobs', archive.manifest.files[0].sha256);
    fs.writeFileSync(blob, 'broken'); assert.equal(maintenanceArchiveMatches(box.root, archive), false);
    fs.writeFileSync(blob, 'before'); assert.equal(maintenanceArchiveMatches(box.root, archive), true);
    fs.renameSync(blob, blob + '.saved'); fs.symlinkSync(blob + '.saved', blob);
    assert.equal(maintenanceArchiveMatches(box.root, archive), false, 'archive symlinks are never followed');
    fs.unlinkSync(blob); fs.renameSync(blob + '.saved', blob);
    box.git('update-ref', '-d', archive.manifest.ref);
    assert.equal(maintenanceArchiveMatches(box.root, archive), false, 'HEAD recovery pin is required');
    assert.equal(fs.readFileSync(leaf, 'utf8'), 'before', 'refusal never deletes local work');
  });

  test('maintenance archive detects an untracked file changing between observation and streamed copy [B3,C7]', t => {
    const box = project(t), leaf = join(box.root, 'changing.bin'); fs.writeFileSync(leaf, Buffer.alloc(2 * 1024 * 1024, 1));
    const identity = fs.statSync(leaf), original = fs.readSync;
    let reads = 0, changed = false;
    fs.readSync = function(fd, ...args) {
      const current = fs.fstatSync(fd);
      if (current.dev === identity.dev && current.ino === identity.ino && ++reads === 4) {
        fs.writeFileSync(leaf, Buffer.alloc(2 * 1024 * 1024, 2)); changed = true;
      }
      return original.call(this, fd, ...args);
    };
    syncBuiltinESMExports();
    try { assert.throws(() => archiveMaintenanceWorktree(box.root, box.common), /changed|identity/u); }
    finally { fs.readSync = original; syncBuiltinESMExports(); }
    assert.equal(changed, true, 'real source mutation occurred during the second file observation');
    assert.equal(fs.readFileSync(leaf)[0], 2, 'changed source is retained, never reset');
  });

  test('clause 1: an archive that would leave under the larger of 10 GB or 5% free is refused with its path and bytes, and the source is untouched [C7]', t => {
    const box = project(t), GiB = 1024 ** 3;
    fs.mkdirSync(join(box.root, 'ignored'));
    const leaf = join(box.root, 'ignored', 'journal.bin');
    fs.writeFileSync(leaf, Buffer.alloc(3 * 1024 * 1024, 9));
    const volume = (freeBytes, totalBytes) => () => ({ freeBytes, totalBytes });
    const archives = join(box.common, 'pullboard', 'worktree-archives');
    assert.throws(() => archiveMaintenanceWorktree(box.root, box.common, { volume: volume(10 * GiB + 1024, 100 * GiB) }),
      error => /^Error: ARCHIVE_WOULD_FILL_DISK/u.test(String(error)) && error.message.includes(box.root)
        && error.message.includes(String(10 * GiB + 1024)) && /needs \d+ bytes/u.test(error.message));
    assert.equal(fs.existsSync(archives), false, 'a refused archive writes nothing');
    assert.equal(fs.readFileSync(leaf).length, 3 * 1024 * 1024, 'the source is untouched');
    assert.throws(() => archiveMaintenanceWorktree(box.root, box.common, { volume: volume(49 * GiB, 1000 * GiB) }), /ARCHIVE_WOULD_FILL_DISK/u,
      '5% of a 1000 GiB volume is 50 GiB, which is larger than 10 GiB');
    assert.throws(() => archiveMaintenanceWorktree(box.root, box.common, { volume: () => { throw new Error('no statfs'); } }), /ARCHIVE_WOULD_FILL_DISK/u,
      'unknown free space never permits the copy');
    const archive = archiveMaintenanceWorktree(box.root, box.common, { volume: volume(60 * GiB, 1000 * GiB) });
    assert.equal(maintenanceArchiveMatches(box.root, archive), true, 'enough room above the reserve archives as before');
    assert.equal(fs.existsSync(join(archive.directory, 'pending.json')), false, 'a finished archive carries no partial marker');
  });

  test('clause 1: the next run removes an interrupted archive without a manifest, only while its source exists, and keeps finished ones [C7]', t => {
    const box = project(t), base = join(box.common, 'pullboard', 'worktree-archives');
    const done = archiveMaintenanceWorktree(box.root, box.common, { volume: () => ({ freeBytes: 2 ** 40, totalBytes: 2 ** 41 }) });
    const partial = (id, root) => {
      const directory = join(base, id);
      fs.mkdirSync(join(directory, 'blobs'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(join(directory, 'pending.json'), JSON.stringify({ id, root }) + '\n', { mode: 0o600 });
      fs.writeFileSync(join(directory, 'blobs', 'half'), 'half a file');
      return directory;
    };
    const live = partial('11111111-1111-4111-8111-111111111111', box.root);
    const orphan = partial('22222222-2222-4222-8222-222222222222', join(box.directory, 'removed-source'));
    const removed = removePartialArchives(box.common);
    assert.deepEqual(removed, ['11111111-1111-4111-8111-111111111111']);
    assert.equal(fs.existsSync(live), false, 'the interrupted archive of a surviving source is removed');
    assert.equal(fs.existsSync(orphan), true, 'an archive whose source is gone may be the only copy and stays');
    assert.equal(fs.existsSync(done.directory), true, 'a finished archive is never removed');
    assert.equal(maintenanceArchiveMatches(box.root, done), true);
  });
}
