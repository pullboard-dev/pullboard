/** @pullboard-test-gui */
/** Real large-board startup and first authenticated page, including its initial state [N26,V4]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeBoard } from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { register } from '../../../../packages/store/index.js';
import { BIN } from '../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../tests/fixtures/cockpit/harness.js';
import { project } from '../../tests/fixtures/cockpit/harness.js';

/** Seed genuine registration history with many seats and shared original sessions, outside the startup budget. */
function seedSeats(box, demo) {
  // @pullboard-board-file journey: native registrations persist in the project database that the real CLI child reopens and serves over authenticated HTTP.
  const board = openBoard(join(demo.repo, '.git', 'pullboard', 'board.sqlite'));
  const ids = [];
  try {
    for (let index = 0; index < 1200; index++) {
      ids.push(register(board, { lane: 'web', path: join(box.dir, `startup-seat-${index}`),
        session: `startup-session-${Math.floor(index / 24)}`, family: 'startup-vendor' }));
    }
  } finally { closeBoard(board); }
  return ids;
}

/** Observe only the owned child's printed link; keep its private URL out of assertion diagnostics. */
function printedLink(child, signal) {
  return new Promise((resolve, reject) => {
    let output = '';
    /** Remove listeners as soon as this startup observation has an outcome. */
    function cleanup() {
      child.stdout.off('data', data);
      child.off('exit', exit);
      signal.removeEventListener('abort', abort);
    }
    /** Wait for the complete native ready line without exposing its credential. */
    function data(chunk) {
      output += chunk;
      const match = /Pullboard view: (http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/u.exec(output);
      if (match) { cleanup(); resolve(new URL(match[1])); }
    }
    /** An early process exit cannot count as a responsive view. */
    function exit(code) { cleanup(); reject(new Error(`view exited before ready (${code})`)); }
    /** The frozen two-second startup budget is enforced by the separate parent process. */
    function abort() { cleanup(); reject(new Error('large-board first page exceeded the #1915 two-second budget')); }
    child.stdout.on('data', data);
    child.once('exit', exit);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

test('large live board serves its first page and agent state within two seconds [N26,V4]', async () => {
  const box = machine(), demo = project(box, 'large-startup');
  const ids = seedSeats(box, demo);
  // Budget: the frozen #1915 first-page requirement, including native ready/setup and initial board data.
  const signal = AbortSignal.timeout(2000);
  const started = performance.now();
  const child = spawn(process.execPath, [BIN, 'view', '--no-open', '--port', '0'], {
    cwd: demo.repo, env: { ...box.env, PULLBOARD_VIEW_FOREGROUND: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    const link = await printedLink(child, signal);
    const headers = { 'x-pullboard-key': link.searchParams.get('k') };
    const page = await fetch(link.origin, { headers, signal });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<!doctype html>/iu);
    const listing = await fetch(link.origin + '/api/v1/boards', { headers, signal });
    assert.equal(listing.status, 200);
    const board = (await listing.json()).boards.find(entry => entry.root === demo.repo);
    assert.ok(board, 'the real project is listed');
    const response = await fetch(`${link.origin}/api/v1/boards/${board.id}/state`, { headers, signal });
    assert.equal(response.status, 200);
    const state = (await response.json()).state;
    const visible = new Map(state.agents.map(agent => [agent.agent_id, agent.agent_family]));
    for (const id of ids) assert.equal(visible.get(id), 'startup-vendor', 'each native seat retains its declared family');
    assert.ok(performance.now() - started < 2000, 'first page and actual board state meet the frozen two-second budget'); // budget: declared frozen #1915 ceiling is 2000 ms, including startup and initial board data.
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
});
