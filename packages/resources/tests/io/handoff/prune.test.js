/** @pullboard-test-input packages/resources/src/io/handoff/prune.js */
/** Finished submit-handoff folders are pruned within 30 minutes by the board's sweep [C7,#3292]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HANDOFF_FOLDER_KEEP_MS } from '../../../index.js';
import { pruneFinishedHandoffs } from '../../../index.js';

/**
 * Make a handoff folder whose result file was written `ageMs` ago; `result` is the file name or null for none. The
 * gate's driver is recorded on the board, never in the folder, so a folder holds only its request, output and result.
 */
function folder(root, name, result, ageMs) {
  const directory = join(root, name);
  mkdirSync(join(directory, 'output'), { recursive: true });
  if (result) {
    writeFileSync(join(directory, result), '{}');
    const at = new Date(Date.now() - ageMs);
    utimesSync(join(directory, result), at, at);
  }
  return directory;
}

test('resources.prune.a-submit-handoffs-folder-whose-gate: clause 1: A submit-handoffs folder whose gate ended (green, red or infra) more than 30 minutes ago is removed by the board\'s sweep, and a queued or running one is never removed [C7,#3292]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pb-prune-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = HANDOFF_FOLDER_KEEP_MS + 60_000;
  const green = folder(root, 'green', 'submission.json', old);
  const red = folder(root, 'red', 'refusal.json', old);
  // A gate whose driver never started ends with the sweep's refusal.json, like any infrastructure stop.
  const infra = folder(root, 'infra', 'refusal.json', old);
  const recent = folder(root, 'recent', 'submission.json', 60_000);
  const queued = folder(root, 'queued', null, 0);
  // A running gate is in the dispatcher's protect set until its driver exits, even after it wrote its result.
  const running = folder(root, 'running', 'submission.json', old);
  const spared = folder(root, 'spared', 'refusal.json', old);
  const removed = pruneFinishedHandoffs([root], { protect: new Set(['spared', 'running']) });
  assert.deepEqual(removed.sort(), [green, infra, red].sort());
  for (const kept of [recent, queued, running, spared]) assert.ok(existsSync(kept), kept);
});
