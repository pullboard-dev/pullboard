/** @pullboard-test-loads apps/cli/src/io/commands/maintenance.js apps/cli/src/io/commands/release.js apps/cli/src/io/worktree/maintenance/command.js */
/** Exercise ordinary CLI output and release cleanup in a disposable native board [B3,C7,N26]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../e2e.js';
import {
  joinFixtureSeat,
  fileFixtureItem,
} from '../testkit.js';

/** Hold a private timer registration with this actual process; no detached worker is needed in these CLI cases. */
function retainFixtureTimer(box) {
  const common = box.git(box.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  const directory = join(common, 'pullboard', 'worktree-maintenance');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(directory, 'timer.guard.sqlite'), '', { mode: 0o600 });
  const started = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='],
    { encoding: 'utf8', env: { ...box.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } }).trim();
  fs.writeFileSync(join(directory, 'timer.json'), JSON.stringify({ version: 1, token: randomUUID(), pid: process.pid,
    started, dueAt: new Date(Date.now() + 3_600_000).toISOString(), root: box.repo, common }), { mode: 0o600 });
  return common;
}

/** Commit only the private fixture's opt-in; no shared project settings are touched. */
function enable(box) {
  const file = join(box.repo, 'pullboard.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.worktreeMaintenance = { enabled: true, every: '1h', grace: '1d', exclude: [] };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-qm', 'chore: enable private fixture maintenance');
}

/** Write bytes into an ignored folder: Git status stays clean, so cleanup may archive and remove it. */
function writeIgnored(box, root, bytes) {
  fs.mkdirSync(join(root, 'ignored'), { recursive: true });
  fs.appendFileSync(join(box.repo, '.git', 'info', 'exclude'), '\nignored/\n');
  fs.writeFileSync(join(root, 'ignored', 'unfinished.bin'), bytes);
}

/** Register only through the owning frozen check. */
export function registerMaintenanceCliTests() {
  test('maintenance CLI defaults off and prints exactly one count and space summary [B3,C7,N26]', t => {
    const helpers = createE2eHelpers(); t.after(helpers.cleanup);
    const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
    const result = box.run(box.repo, 'maintenance');
    assert.equal(result.code, 0, result.err);
    assert.match(result.out.trim(), /^maintenance: active 0, finished 0, orphaned 0, scratch 0; pruned 0; archived 0; space freed 0 B; off$/u);
    assert.equal(result.out.trim().split('\n').length, 1);
    assert.equal(fs.existsSync(join(box.repo, '.git', 'pullboard', 'worktree-maintenance')), false);
    const json = box.run(box.repo, 'maintenance', '--json');
    assert.equal(json.code, 0, json.err);
    assert.equal(JSON.parse(json.out).enabled, false);
  });

  test('clause 1: ordinary release archives ignored owner files before cleaning and records its recovery fact [B3,C7,N26]', t => {
    const helpers = createE2eHelpers(); t.after(helpers.cleanup);
    const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
    enable(box);
    const common = retainFixtureTimer(box), owner = join(box.dir, 'web-owner');
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', owner, 'main');
    const joined = joinFixtureSeat(box, owner, 'web');
    assert.equal(joined.code, 0, joined.err);
    const id = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Private release archive', diagnose: false,
      criterion: 'The fixture can release its own work.', args: ['--specs', 'G1'],
      brief: 'Files:\n- web/page.js\nChange:\n- Exercise private release.\nTest:\n- Native release retains archive evidence.' }).item_id;
    const claimed = box.run(owner, 'claim', String(id), '--json');
    assert.equal(claimed.code, 0, claimed.err);
    const bytes = Buffer.from([0, 5, 6, 255]);
    writeIgnored(box, owner, bytes);
    const released = box.run(owner, 'release', String(id), '--reason', 'OTHER', '--note', 'fixture release', '--no-next', '--json');
    assert.equal(released.code, 0, released.err);
    assert.equal(fs.existsSync(join(owner, 'ignored', 'unfinished.bin')), false, released.err);
    assert.equal(box.git(owner, 'status', '--porcelain').trim(), '');
    const directory = join(common, 'pullboard', 'worktree-archives');
    const manifests = fs.readdirSync(directory).map(name => ({ directory: join(directory, name),
      value: JSON.parse(fs.readFileSync(join(directory, name, 'manifest.json'), 'utf8')) }));
    const archive = manifests.find(row => row.value.root === owner);
    assert.ok(archive, 'the cleanup has a persisted private recovery manifest');
    const file = archive.value.files.find(row => row.path === 'ignored/unfinished.bin');
    assert.deepEqual(fs.readFileSync(join(archive.directory, 'blobs', file.sha256)), bytes);
    const log = box.run(box.repo, 'log', String(id), '--json');
    assert.equal(log.code, 0, log.err);
    assert.match(log.out, /Worktree work archived before maintenance cleanup/u);
    const refused = box.run(owner, 'maintenance', '--json');
    assert.equal(refused.code, 1);
    assert.match(refused.out + refused.err, /COORDINATOR_ONLY/u);
  });

  test('clause 1: ordinary release leaves a worktree with uncommitted changes in place and records a fact naming it and its dirty paths [C7]', t => {
    const helpers = createE2eHelpers(); t.after(helpers.cleanup);
    const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
    enable(box);
    const common = retainFixtureTimer(box), owner = join(box.dir, 'web-dirty-owner');
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', owner, 'main');
    assert.equal(joinFixtureSeat(box, owner, 'web').code, 0);
    const id = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Private dirty release' }).item_id;
    assert.equal(box.run(owner, 'claim', String(id), '--json').code, 0);
    const bytes = Buffer.from([0, 7, 8, 255]);
    fs.writeFileSync(join(owner, 'unfinished.bin'), bytes);
    const released = box.run(owner, 'release', String(id), '--reason', 'OTHER', '--note', 'fixture release', '--no-next', '--json');
    assert.equal(released.code, 0, released.err);
    assert.deepEqual(fs.readFileSync(join(owner, 'unfinished.bin')), bytes, 'release never removes uncommitted work');
    assert.notEqual(box.git(owner, 'status', '--porcelain').trim(), '');
    assert.equal(fs.existsSync(join(common, 'pullboard', 'worktree-archives')), false, 'no archive, reset or clean runs on a dirty tree');
    const log = box.run(box.repo, 'log', String(id), '--json');
    assert.equal(log.code, 0, log.err);
    assert.match(log.out, /Worktree kept by maintenance because it holds uncommitted changes/u);
    assert.ok(log.out.includes('unfinished.bin') && log.out.includes(owner));
  });
}
