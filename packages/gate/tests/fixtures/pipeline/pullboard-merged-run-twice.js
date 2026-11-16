/**
 * Pullboard merged run twice [C7]: the second `merged` for an item names the first record instead of overwriting it.
 * The invariant: a repeat for the same commit is a no-op that appends no second merged event; a repeat naming a
 * different commit is refused MERGED_ALREADY, naming both commits, and leaves item_merged_commit as it was.
 * Run alone with `node packages/gate/tests/fixtures/pipeline/pullboard-merged-run-twice.js`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  ROOT,
  from,
  guardProcesses,
  hopCheck,
  track,
} from './kit.js';

const { machine, project } = await from('apps/cli/tests/fixtures/cockpit/machine.js');
const { fileFixtureItem } = await from('packages/gate/tests/fixtures/testkit.js');

guardProcesses();

test('a second merged for a recorded item names the record and a different commit is refused MERGED_ALREADY [C7]', { timeout: 240_000 }, async () => {
  await hopCheck('merged-twice', async () => {
    const started = Date.now();
    const box = machine(), alpha = project(box, 'merged-twice');
    track(box.dir);
    fileFixtureItem(box, alpha.repo, { lane: 'web', title: 'A merged-twice harness item', check: 'test -f pullboard.json', args: ['--specs', 'G1'], wait: true,
      run: (root, ...args) => ({ code: 0, out: box.run(root, ...args), err: '' }) });
    const run = (...args) => spawnSync(process.execPath, [`${ROOT}/apps/cli/pullboard.js`, ...args], { cwd: alpha.repo, env: box.env, encoding: 'utf8' });
    const merges = () => JSON.parse(run('log', '1', '--json').stdout).events.filter(event => event.event_kind === 'merged');
    const recorded = () => JSON.parse(run('show', '1', '--json').stdout).item_merged_commit;
    const first = box.git(alpha.repo, 'rev-parse', 'HEAD');
    const one = run('merged', '1', first, '--forced', 'harness: first record', '--waive-proof', 'harness has no receipt');
    assert.equal(one.status, 0, one.stdout + one.stderr);
    assert.equal(merges().length, 1, 'the first run records one merged event');
    assert.equal(recorded(), first);
    // The same commit again: a no-op that names the record.
    const same = run('merged', '1', first, '--forced', 'harness: repeat');
    assert.equal(same.status, 0, same.stdout + same.stderr);
    assert.match(same.stdout, /already merged/u, 'the repeat names the existing record');
    assert.equal(merges().length, 1, 'the repeat appends no second merged event');
    // A different commit on main: refused, and the record stays as it was.
    box.git(alpha.repo, 'commit', '-q', '--allow-empty', '-m', 'chore(fixture): a different commit');
    const other = box.git(alpha.repo, 'rev-parse', 'HEAD');
    const refused = run('merged', '1', other, '--forced', 'harness: different commit');
    const said = refused.stdout + refused.stderr;
    assert.notEqual(refused.status, 0, 'a different commit is refused');
    assert.match(said, /MERGED_ALREADY/u);
    assert.ok(said.includes(first) && said.includes(other), 'the refusal names both commits');
    assert.equal(recorded(), first, 'item_merged_commit is not overwritten');
    assert.equal(merges().length, 1, 'the refused run logs no merged event');
    return { ms: Date.now() - started, measured: `repeat of ${first.slice(0, 7)} was a no-op; ${other.slice(0, 7)} was refused MERGED_ALREADY; one merged event` };
  });
});
