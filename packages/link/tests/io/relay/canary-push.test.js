/** @pullboard-test-input source-cell link */
/** The canary push sender posts a sealed payload to each stored endpoint through injected seal and post [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendCanaryPush } from '../../../src/io/relay/canary-push.js';

const SUBSCRIPTIONS = ['https://push.example/a', 'https://push.example/b', 'https://push.example/c']
  .map(endpoint => ({ endpoint, keys: { p256dh: `p-${endpoint}`, auth: 'a' } }));

test('link.canary-push.one-post-per-endpoint: clause 1: with the relay unreachable, sendCanaryPush posts one sealed payload to each stored endpoint [C7]', async () => {
  const posts = [];
  const result = await sendCanaryPush({
    subscriptions: SUBSCRIPTIONS, payload: 'canary',
    seal: (payload, keys) => Buffer.from(`sealed:${payload}:${keys.p256dh}`),
    sign: endpoint => `vapid ${endpoint}`,
    post: async (endpoint, request) => { posts.push({ endpoint, ...request }); },
  });
  assert.deepEqual(result.sent, SUBSCRIPTIONS.map(row => row.endpoint));
  assert.deepEqual(result.failed, []);
  assert.equal(posts.length, 3);
  for (const [index, row] of posts.entries()) {
    assert.equal(row.endpoint, SUBSCRIPTIONS[index].endpoint);
    assert.equal(row.body.toString(), `sealed:canary:p-${SUBSCRIPTIONS[index].endpoint}`);
    assert.equal(row.headers.authorization, `vapid ${SUBSCRIPTIONS[index].endpoint}`);
  }
});

test('link.canary-push.failure-does-not-block-others: clause 2: a failing endpoint is reported and the other endpoints still get their post [C7]', async () => {
  const posted = [];
  const result = await sendCanaryPush({
    subscriptions: SUBSCRIPTIONS, payload: 'canary',
    seal: () => Buffer.from('x'), sign: () => 't',
    post: async endpoint => { if (endpoint.endsWith('/b')) throw new Error('410 gone'); posted.push(endpoint); },
  });
  assert.deepEqual(posted, ['https://push.example/a', 'https://push.example/c']);
  assert.deepEqual(result.sent, posted);
  assert.deepEqual(result.failed, [{ endpoint: 'https://push.example/b', reason: '410 gone' }]);
});
