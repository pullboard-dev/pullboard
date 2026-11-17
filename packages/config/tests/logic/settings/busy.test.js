/** Raising a busy runner's slot or browser count applies at once; only a decrease waits for active runs [C7,#3502]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { addRunner } from '../../../index.js';
import { loadMachineSettings } from '../../../index.js';
import { listResources } from '../../../../resources/index.js';
import { takeResource } from '../../../../resources/index.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';

/** Point the machine home at a private directory for one case and restore it afterwards. */
function isolate() {
  const { root: dir } = privateFixtureFiles('pullboard-runner-settings-busy-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  return { dir, restore: () => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; } };
}

/** Record one active slot for a runner exactly as an admitted remote run holds it. */
function holdRunnerSlot(host) {
  const db = new DatabaseSync(join(process.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.prepare('INSERT INTO holder(token, name, pid, started, agent, repo, since, heartbeat, browser, item, kind, runner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)')
      .run('held-token', `runner:${host}`, process.pid, '', 'fixture', 'fixture', new Date().toISOString(), Date.now(), '1', 'gate', host);
  } finally { db.close(); }
}

test('config.logic-settings-busy.clause-1-runner-add-with-slots-and: clause 1: runner add with slots and browser at or above the current ones succeeds while the runner has active slots, and a decrease still refuses RUNNER_BUSY [C7,#3502]', () => {
  const box = isolate();
  try {
    const base = { host: 'busy-runner.example.invalid', node: 'node', root: '/srv/busy', fixed: true };
    addRunner({ ...base, slots: 9, browser: 6 });
    holdRunnerSlot(base.host);
    const raised = addRunner({ ...base, slots: 14, browser: 10 });
    assert.equal(raised.slots, 14);
    assert.equal(raised.browser, 10);
    const stored = loadMachineSettings().runners.find(runner => runner.host === base.host);
    assert.equal(stored.slots, 14, 'the next admission reads the raised slots');
    assert.equal(stored.browser, 10, 'the next admission reads the raised browser count');
    assert.equal(listResources({ scope: 'machine' }).find(row => row.name === `runner:${base.host}`).capacity, 14);
    assert.throws(() => addRunner({ ...base, slots: 12, browser: 10 }), { code: 'RUNNER_BUSY' });
    assert.throws(() => addRunner({ ...base, slots: 14, browser: 8 }), { code: 'RUNNER_BUSY' });
    assert.equal(loadMachineSettings().runners.find(runner => runner.host === base.host).slots, 14, 'a refused decrease changes nothing');
  } finally { box.restore(); }
});

test('config.logic-settings-busy.clause-2-the-pool-grows-gate-and-browser: clause 2: the pool grows gate and browser capacity on the next run while it has holders, and a decrease still refuses RESOURCE_CAPACITY_MISMATCH [C7,#3502]', async () => {
  const box = isolate();
  const held = [];
  /** Take one gate slot with the given gate and browser capacity. */
  const take = (gate, browser, allowCapacityGrowth) => takeResource({ name: 'gate', capacity: gate, scope: 'machine', browser: true, browserCapacityProvider: () => browser, allowIdleCapacityUpdate: true, allowCapacityGrowth, agent: 'fixture', item: '1', kind: 'gate' });
  try {
    held.push(await take(9, 6, true));
    held.push(await take(14, 10, true));
    const rows = Object.fromEntries(listResources({ scope: 'machine' }).map(row => [row.name, row.capacity]));
    assert.equal(rows.gate, 14, 'gate grew while held');
    assert.equal(rows.browser, 10, 'browser grew while held');
    await assert.rejects(() => take(14, 8, true), { code: 'RESOURCE_CAPACITY_MISMATCH' });
    assert.equal(listResources({ scope: 'machine' }).find(row => row.name === 'browser').capacity, 10, 'a refused decrease changes nothing');
  } finally { for (const slot of held) slot.release(); box.restore(); }
});
