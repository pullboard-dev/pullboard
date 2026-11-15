/**
 * A shout names an item this seat cannot act on [C7]: `next --wait` hears it and keeps waiting.
 * The invariant: a shout ends the wait with "a shout asks you to act on #N" only when #N is open in the seat's lane,
 * claimed by the seat, or reservable by it for review. A shout naming another lane's open item is printed, the wait
 * goes on, and the seat is handed nothing; the same shout naming an open item of its own lane does end the wait.
 * Run alone with `node packages/gate/tests/fixtures/pipeline/a-shout-names-an-item-this-seat-cannot-a.js`.
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

const { machine, project, SPEC } = await from('apps/cli/tests/fixtures/cockpit/machine.js');
const { fileFixtureItem } = await from('apps/cli/tests/fixtures/testkit.js');

guardProcesses();

/** The lanes the fixture board declares: the seat's own, and one it does not belong to. */
const LANES = { web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };

test('a shout naming another lane\'s item does not end next --wait; one naming an item of the seat\'s lane does [C7]', { timeout: 240_000 }, async () => {
  await hopCheck('shout-scope', async () => {
    const started = Date.now();
    const box = machine();
    track(box.dir);
    const alpha = project(box, 'shout-scope', SPEC, { lanes: LANES });
    const file = lane => fileFixtureItem(box, alpha.repo, { lane, title: `A ${lane} shout-scope item`, check: 'test -f pullboard.json', args: ['--specs', 'G1'], wait: true,
      run: (root, ...args) => ({ code: 0, out: box.run(root, ...args), err: '' }) });
    const cli = (cwd, ...args) => spawnSync(process.execPath, [`${ROOT}/apps/cli/pullboard.js`, ...args], { cwd, env: box.env, encoding: 'utf8', timeout: 120_000 });
    const asked = 'a shout asks you to act on';
    // Only an api item is open: the web seat cannot act on it, and the coordinator's shout names it anyway.
    const other = file('api');
    const shoutOther = cli(alpha.repo, 'shout', 'web', `please build #${other.item_id} next`, '--kind', 'idea');
    assert.equal(shoutOther.status, 0, shoutOther.stdout + shoutOther.stderr);
    const ignored = cli(alpha.web, 'next', '--wait', '0.1');
    const heardOther = ignored.stdout + ignored.stderr;
    assert.match(heardOther, new RegExp(`please build #${other.item_id} next`, 'u'), 'the shout is still printed');
    assert.doesNotMatch(heardOther, new RegExp(asked, 'u'), 'a shout naming another lane\'s item does not end the wait');
    // An open item of the seat's own lane: the same kind of shout now ends the wait naming it.
    const own = file('web');
    const shoutOwn = cli(alpha.repo, 'shout', 'web', `please build #${own.item_id} next`, '--kind', 'idea');
    assert.equal(shoutOwn.status, 0, shoutOwn.stdout + shoutOwn.stderr);
    const acted = cli(alpha.web, 'next', '--wait', '0.1');
    assert.match(acted.stdout + acted.stderr, new RegExp(`${asked} #${own.item_id}\\b`, 'u'), 'a shout naming an item of the seat\'s lane ends the wait');
    return { ms: Date.now() - started, measured: `the shout naming #${other.item_id} (api) was printed and the wait went on; the one naming #${own.item_id} (web) ended it` };
  });
});
