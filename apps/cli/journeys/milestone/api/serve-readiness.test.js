import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { project } from '../../../tests/fixtures/api/project.js';
import { startApi } from '../../../tests/fixtures/api/milestone.js';

test('[A2,C7] a missed serve readiness deadline names the slow startup phase', async (t) => {
  const box = project();
  const phaseReachedFile = join(box.dir, 'startup-phase-reached');
  const releaseFile = join(box.dir, 'release-held-startup');
  const traceFile = join(box.dir, 'held-startup-trace.jsonl');
  rmSync(phaseReachedFile, { force: true });
  rmSync(releaseFile, { force: true });
  await assert.rejects(startApi(t, box, {
    traceStartup: true,
    traceFile,
    readinessTimeoutMs: 1_000, // budget: short deterministic observation ceiling after the held registration-start phase.
    holdPhase: 'serve-registration-start',
    phaseReachedFile,
    releaseFile,
  }), (error) => {
    assert.match(error.message, /serve readiness deadline \(1000ms\) expired/);
    assert.match(error.message, /last phase reached: serve-registration-start/);
    assert.match(error.message, /process-entry: \d+ms since child start/);
    assert.match(error.message, /cli-module-load-complete: \d+ms since child start/);
    assert.match(error.message, /cli-command-preamble-ready: \d+ms since child start/);
    assert.match(error.message, /serve-context-start: \d+ms since child start/);
    assert.match(error.message, /serve-context-ready: \d+ms since child start/,
      'the timeout names the recorded context-ready phase');
    assert.ok(error.startupPhases.length > 0, 'the timeout retains its captured phases');
    for (const { phase } of error.startupPhases) assert.ok(error.startupDiagnostics.includes(`- ${phase}:`),
      `the diagnostic lists recorded phase ${phase}`);
    assert.ok(error.message.includes(error.startupDiagnostics), 'the thrown error includes the emitted diagnostic lines');
    assert.deepEqual(error.startupPhases.map(({ phase }) => phase).slice(-1), ['serve-registration-start']);
    assert.match(error.startupDiagnostics, /last phase reached: serve-registration-start/);
    return true;
  });
});
