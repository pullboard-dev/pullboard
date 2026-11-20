/** @pullboard-test-input source-cell link */
/** handOverKeys answers the vouch check through io.githubKeys, so a fake reader decides it and no GitHub fetch runs [C7,#12429]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handOverKeys } from '../../../src/io/relay/handover.js';

const BOARD = 'a'.repeat(32);

test('link.io-relay-handover.keys-through-io: clause 1: handOverKeys passes io.githubKeys to handOverBoardKeys, so a fake io.githubKeys answers the vouch check and no fetch runs [C7,#12429]', async () => {
  const state = { board: BOARD, repository: 'owner/repo' };
  const entry = { id: 'req1', login: 'alice', signature: 'not-a-signature',
    statement: { board: BOARD, repository: 'owner/repo', login: 'alice', expires: Date.now() + 60_000 } };
  const asked = [];
  const sent = [];
  const errors = [];
  const io = {
    githubKeys: async login => { asked.push(login); return []; },
    err: line => errors.push(line),
    keyRequestsWaiting: true,
  };
  const send = async (_state, path, options) => {
    sent.push({ path, method: options?.method ?? 'GET', body: options?.body });
    return options?.method === 'PUT' ? {} : { requests: [entry] };
  };
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = () => { fetched += 1; return Promise.reject(new Error('no network in this case')); };
  try { await handOverKeys('/unused-root', state, new Uint8Array(32), send, io); }
  finally { globalThis.fetch = realFetch; }
  assert.deepEqual(asked, ['alice'], 'the fake io.githubKeys answered the vouch check');
  assert.equal(fetched, 0, 'no GitHub fetch ran');
  const put = sent.find(call => call.method === 'PUT');
  assert.equal(put?.body?.refused?.code, 'RELAY_KEY_VOUCH', 'an empty key list refuses the request by name');
  assert.equal('keyRequestsWaiting' in io, false, 'the waiting flag is cleared');
  assert.equal(errors.some(line => line.includes('refused a new device of alice')), true);
});
