/** @pullboard-test-input source-tree */
/** Finished submit-handoff folders are pruned within 30 minutes by the dispatcher loop [C7,#3292]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HANDOFF_FOLDER_KEEP_MS, pruneFinishedHandoffs } from '../packages/resources/index.js';

/** Make a handoff folder whose result file was written `ageMs` ago; `result` is the file name or null for none. */
function folder(root, name, result, ageMs, worker = { version: 1, job: name, pid: null }) {
  const directory = join(root, name);
  mkdirSync(join(directory, 'output'), { recursive: true });
  writeFileSync(join(directory, 'worker.json'), JSON.stringify(worker));
  if (result) {
    writeFileSync(join(directory, result), '{}');
    const at = new Date(Date.now() - ageMs);
    utimesSync(join(directory, result), at, at);
  }
  return directory;
}

test('clause 1: A submit-handoffs folder whose gate ended (green, red or infra) more than 30 minutes ago is removed by the board\'s sweep, and a queued or running one is never removed [C7,#3292]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pb-prune-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = HANDOFF_FOLDER_KEEP_MS + 60_000;
  const green = folder(root, 'green', 'submission.json', old);
  const red = folder(root, 'red', 'refusal.json', old);
  const infra = folder(root, 'infra', null, old, { version: 1, job: 'infra', pid: null, unstarted: { code: 'X' } });
  const infraFile = join(infra, 'worker.json');
  utimesSync(infraFile, new Date(Date.now() - old), new Date(Date.now() - old));
  const recent = folder(root, 'recent', 'submission.json', 60_000);
  const queued = folder(root, 'queued', null, 0);
  const running = folder(root, 'running', 'submission.json', old, { version: 1, job: 'running', pid: process.pid });
  const spared = folder(root, 'spared', 'refusal.json', old);
  const removed = pruneFinishedHandoffs([root], { protect: new Set(['spared']) });
  assert.deepEqual(removed.sort(), [green, infra, red].sort());
  for (const kept of [recent, queued, running, spared]) assert.ok(existsSync(kept), kept);
});

test('clause 2: The sweep runs on its own from the dispatcher loop, with no person or agent command [C7,#3292]', () => {
  const source = readFileSync(new URL('../packages/resources/src/shell/handoff-worker-cap.js', import.meta.url), 'utf8');
  const loop = source.slice(source.indexOf('async function dispatchWhileQueued'));
  assert.match(loop, /sweepFinished\(running\)/u);
  assert.match(loop, /rememberHandoffRoot\(launch\.directory\)/u);
});
