/** @pullboard-test-input source-cell link config */
/** With canary.directPush on, a canary alert calls the direct push sender; with relay.push on it also posts a sealed wake-up to the relay; with either off the alert path is unchanged [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { canaryDirectPushEnabled } from '../../../../config/index.js';
import { loadMachineSettings } from '../../../../config/index.js';
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

test('link.canary-push-wire.on-sends-stored-subscriptions: clause 1: with canary.directPush on and the relay unreachable, a canary alert calls sendCanaryPush with the stored subscriptions [C7]', async t => {
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

test('link.canary-push-wire.off-posts-nothing: clause 2: with canary.directPush off the alert path is identical to today and nothing is posted [C7]', async t => {
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

/** The wake ports a canary host passes in: relay.push read from the machine settings, a seal that hides the text, and a post that records. */
function wakePorts(posts) {
  return { enabled: () => loadMachineSettings().relay?.push === true, seal: text => Buffer.from(text).toString('base64url'),
    post: async wake => { posts.push(wake); } };
}

/** One canary run whose probe fails, with the wake ports and no direct push. */
function runWake(root, relayWake, notify) {
  return runRelayCanary({ enabled: true, root, agentId: 'canary-1', deadlineMs: 1000 }, { probe: async () => FAILED, now: () => Date.parse(FAILED.at), notify, relayWake });
}

test('link.canary-push-wire.relay-wake-sealed: clause 1: with relay.push on, a canary alert is sealed through the seal port and only its kind and sealed blob are posted to the relay push/wake [C7]', async t => {
  await withAlert(t, { relay: { push: true } }, async root => {
    const posts = [];
    await assert.rejects(runWake(root, wakePorts(posts), async () => { throw new Error('relay unreachable'); }), /relay unreachable/u);
    assert.equal(posts.length, 1);
    assert.deepEqual(Object.keys(posts[0]).sort(), ['kind', 'sealed']);
    assert.equal(posts[0].kind, 'alerts');
    assert.match(Buffer.from(posts[0].sealed, 'base64url').toString(), /^Relay canary alert/u);
    assert.equal(JSON.stringify(posts).includes('RELAY_READ'), false, 'no alert text leaves unsealed');
  });
});

test('link.canary-push-wire.relay-wake-off: clause 2: with relay.push off the alert path is identical to today and nothing is posted [C7]', async t => {
  await withAlert(t, {}, async root => {
    const posts = [];
    const recorded = [];
    await runWake(root, wakePorts(posts), async notice => { recorded.push(notice.id); });
    assert.ok(recorded.length > 0, 'the native notice is still recorded exactly as before');
    assert.deepEqual(posts, []);
  });
});
