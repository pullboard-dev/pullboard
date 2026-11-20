/** One serve claims per runner host: the daemon copy waits while the GUI-session copy of its install runs [P7,#10840]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { testGit as pullGit } from '../../fixtures/git.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';

/** A board stand-in that hands one job to the first claim and nothing after; every call lands in `events`, and the serve stops once the job posts. */
function oneJobBoard(t, events) {
  const { root: cache } = privateFixtureFiles('pullboard-one-serve-');
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const stop = new AbortController();
  let claims = 0;
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    events.push(call.action);
    let reply = { recorded: true, renewed: true };
    if (call.action === 'claim') {
      claims += 1;
      reply = claims === 1 ? { claim: { job: 'land:1', kind: 'land', needs: [], run: [], candidate: null, base: null, attempt: 1, token: 'r-one:1' }, trunk: 'unused' } : { claim: null };
    }
    if (call.action === 'receipt') stop.abort();
    return { status: 200, json: async () => reply };
  };
  const handlers = { land: async () => ({ merged: true }) };
  return options => serveRunner({ git: pullGit, board: BOARD, runner: 'r-one', capabilities: [], cache, signal: stop.signal, fetchImpl, handlers, say: () => {}, sleep: () => new Promise(resolve => setImmediate(resolve)), trunkPack: async () => {}, ...options });
}

test('runners.onserve.n10840-clause-1-a-daemon-serve-waits: #10840 clause 1: a daemon serve given a peer port that reports a GUI-session serve of its install claims no job and keeps waiting, and claims as today once the port reports none [P7]', async t => {
  const events = [];
  const serve = oneJobBoard(t, events);
  let asked = 0;
  const peer = { session: 'daemon', guiRunning: () => { asked += 1; events.push('peer'); return asked <= 3; } };
  const served = await serve({ peer });
  assert.equal(events.slice(0, 3).join(), 'peer,peer,peer', 'three waits before any claim');
  assert.equal(events.indexOf('claim'), 4, events.join(' '));
  assert.deepEqual(served.jobs.map(entry => [entry.job, entry.outcome]), [['land:1', 'posted']]);
});

test('runners.onserve.n10840-clause-2-a-gui-serve-or-the-setting-off: #10840 clause 2: a serve that is itself the GUI-session copy claims as today whatever the port reports, and with the setting off no peer check is made [P7]', async t => {
  const events = [];
  let asked = 0;
  const gui = await oneJobBoard(t, events)({ peer: { session: 'gui', guiRunning: () => { asked += 1; return true; } } });
  assert.deepEqual(gui.jobs.map(entry => entry.outcome), ['posted']);
  assert.equal(asked, 0, 'a GUI copy never asks');
  const off = await oneJobBoard(t, [])({});
  assert.deepEqual(off.jobs.map(entry => entry.outcome), ['posted']);
});
