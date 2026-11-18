/** @pullboard-module-loads packages/drive/src/io/pull.js */
/** A pull serve rebuilds its own runner code once the board reports a newer trunk commit, after its held jobs post [C7,P7,#10800]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { testGit as pullGit } from '../../fixtures/git.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';

/** A board stand-in that answers each claim from a script, then an empty queue; every call lands in `events`. */
function scriptedBoard(t, answers, events) {
  const { root: cache } = privateFixtureFiles('pullboard-runner-code-');
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  let claims = 0;
  const stop = new AbortController();
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    events.push(call.action);
    let reply = { recorded: true, renewed: true };
    if (call.action === 'claim') {
      claims += 1;
      reply = answers[claims - 1] ?? { claim: null };
      if (claims >= answers.length) stop.abort();
    }
    return { status: 200, json: async () => reply };
  };
  const serve = options => serveRunner({ git: pullGit, board: BOARD, runner: 'r-code', capabilities: [], cache, signal: stop.signal, fetchImpl, sleep: () => new Promise(resolve => setImmediate(resolve)), trunkPack: async () => {}, ...options });
  return { serve, claims: () => claims };
}

test('runners.code.n10800-clause-1-a-changed-runnercommit-drains: #10800 clause 1: a claim answer whose runnerCommit the port reports changed stops claiming, lets the held job post its receipt, then calls refresh(runnerCommit) and returns asking for a restart [P7]', async t => {
  const events = [];
  const { serve, claims } = scriptedBoard(t, [{ claim: { job: 'land:1', kind: 'land', needs: [], run: [], candidate: null, base: null, attempt: 1, token: 'r-code:1' }, trunk: 'unused', runnerCommit: 'c2' }, { claim: null }], events);
  let compared;
  const held = new Promise(resolve => { compared = resolve; });
  const handlers = { land: async () => { events.push('handler-start'); await held; events.push('handler-end'); return { merged: true }; } };
  const port = { changed: async commit => { events.push(`changed:${commit}`); compared(); return true; }, refresh: async commit => { events.push(`refresh:${commit}`); } };
  const served = await serve({ handlers, runnerCode: port });
  assert.equal(served.restart, 'c2');
  assert.equal(claims(), 1, 'no claim after the changed commit');
  assert.ok(events.indexOf('receipt') > events.indexOf('handler-end'), events.join(' '));
  assert.ok(events.indexOf('refresh:c2') > events.indexOf('receipt'), `refresh came after the receipt: ${events.join(' ')}`);
  assert.deepEqual(served.jobs.map(entry => entry.outcome), ['posted']);
});

test('runners.code.n10800-clause-2-an-unchanged-or-absent: #10800 clause 2: a runnerCommit the port reports unchanged, or a claim answer with no runnerCommit, keeps claiming as today and never calls refresh [P7]', async t => {
  const events = [];
  const { serve, claims } = scriptedBoard(t, [{ claim: null, runnerCommit: 'c1' }, { claim: null }, { claim: null, runnerCommit: 'c1' }, { claim: null }], events);
  const refreshed = [];
  const port = { changed: async () => false, refresh: async commit => { refreshed.push(commit); } };
  const served = await serve({ runnerCode: port });
  assert.equal(served.restart, undefined);
  assert.equal(claims(), 4, 'it kept claiming');
  assert.deepEqual(refreshed, []);
});

test('runners.code.n10800-clause-3-a-failed-refresh-is: #10800 clause 3: a refresh that fails is said once and the runner keeps claiming on its current code, trying again at the next new runnerCommit [P7]', async t => {
  const events = [];
  const { serve, claims } = scriptedBoard(t, [{ claim: null, runnerCommit: 'c2' }, { claim: null, runnerCommit: 'c2' }, { claim: null, runnerCommit: 'c3' }, { claim: null }], events);
  const refreshed = [];
  const said = [];
  const port = { changed: async () => true, refresh: async commit => { refreshed.push(commit); throw new Error('disk full'); } };
  const served = await serve({ runnerCode: port, say: line => said.push(line) });
  assert.equal(served.restart, undefined);
  assert.equal(claims(), 4, 'it kept claiming after each failure');
  assert.deepEqual(refreshed, ['c2', 'c3'], 'one try per new commit');
  assert.equal(said.filter(line => line.includes('runner code update to c2')).length, 1);
  assert.equal(said.filter(line => line.includes('runner code update to c3')).length, 1);
});

test('drive.pull.runner-code-lazy: #10872 clause 1: evaluating pull.js resolves no import of pull/runner-code.js, so cold commands stay inside their closure budgets [C7]', async () => {
  const resolved = [];
  const hooks = registerHooks({ resolve(specifier, context, next) { const found = next(specifier, context); resolved.push(found.url); return found; } });
  try { await import(`${new URL('../../../src/io/pull.js', import.meta.url).href}?lazy-check`); } finally { hooks.deregister(); }
  assert.ok(resolved.length > 5, `pull.js resolved ${resolved.length} imports`);
  assert.deepEqual(resolved.filter(url => url.endsWith('/pull/runner-code.js')), []);
});
