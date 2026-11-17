/** @pullboard-test-input source-cell link config */
/** With canary.directPush on, a canary alert calls the direct push sender; with it off the alert path is unchanged [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { canaryDirectPushEnabled } from '../../../../config/index.js';
import { observeRelayHealth } from '../../../index.js';
import { pendingRelayCanaryNotices } from '../../../index.js';
import { runRelayCanary } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

const SUBSCRIPTIONS = ['https://push.example/a', 'https://push.example/b']
  .map(endpoint => ({ endpoint, keys: { p256dh: `p-${endpoint}`, auth: 'a' } }));
const FAILED = { ok: false, step: 'pull', code: 'RELAY_READ', roundTripMs: 2, at: '2026-11-17T00:00:00.000Z' };

/** Run `body` with a private machine home holding `settings` and a private repo that holds a persisted canary alert. */
async function withAlert(t, settings, body) {
  const { root: dir } = privateFixtureFiles('pullboard-canary-wire-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { root } = cellRepo(t, { real: true });
  observeRelayHealth(root, FAILED);
  assert.equal(observeRelayHealth(root, FAILED).transition, 'alert');
  const home = join(dir, 'machine-home');
  mkdirSync(home);
  fixtureMachineSettings(home, settings);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  try { return await body(root); }
  finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The ports a canary host passes in, recording every post it would make. */
function ports(posts) {
  return { enabled: canaryDirectPushEnabled, subscriptions: () => SUBSCRIPTIONS,
    seal: (payload, keys) => Buffer.from(`sealed:${keys.p256dh}`), sign: endpoint => `vapid ${endpoint}`,
    post: async (endpoint, request) => { posts.push({ endpoint, ...request }); } };
}

/** One canary run whose probe fails and whose native notice cannot be recorded because the relay is unreachable. */
function runDown(root, directPush) {
  const config = { enabled: true, root, agentId: 'canary-1', deadlineMs: 1000 };
  return runRelayCanary(config, { probe: async () => FAILED, now: () => Date.parse(FAILED.at),
    notify: async () => { throw new Error('relay unreachable'); }, directPush });
}

test('clause 1: with canary.directPush on and the relay unreachable, a canary alert calls sendCanaryPush with the stored subscriptions [C7]', async t => {
  await withAlert(t, { canary: { directPush: true } }, async root => {
    assert.ok(pendingRelayCanaryNotices(root).length > 0, 'the fixture holds a pending alert');
    const posts = [];
    await assert.rejects(runDown(root, ports(posts)), /relay unreachable/u);
    assert.deepEqual(posts.map(post => post.endpoint), SUBSCRIPTIONS.map(row => row.endpoint));
    for (const [index, post] of posts.entries()) {
      assert.equal(post.body.toString(), `sealed:${SUBSCRIPTIONS[index].keys.p256dh}`);
      assert.equal(post.headers.authorization, `vapid ${SUBSCRIPTIONS[index].endpoint}`);
    }
  });
});

test('clause 2: with canary.directPush off the alert path is identical to today and nothing is posted [C7]', async t => {
  await withAlert(t, {}, async root => {
    const posts = [];
    await assert.rejects(runDown(root, ports(posts)), /relay unreachable/u);
    assert.deepEqual(posts, []);
    const recorded = [];
    await runRelayCanary({ enabled: true, root, agentId: 'canary-1', deadlineMs: 1000 }, { probe: async () => FAILED,
      notify: async notice => { recorded.push(notice.id); } });
    assert.ok(recorded.length > 0, 'the native notice is still recorded exactly as before');
    assert.deepEqual(posts, []);
  });
});
