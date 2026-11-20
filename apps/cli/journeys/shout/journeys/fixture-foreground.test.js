// pullboard: browser
/** @pullboard-test-gui */
/** @pullboard-test-input source-cell apps/cli apps/lib store */
/** The cockpit helper starts its view in the foreground [C7,N26]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  pathToFileURL,
} from 'node:url';
import {
  test,
} from 'node:test';
import {
  machine,
  project,
  fetchLive,
  startView,
} from '../../../tests/fixtures/cockpit/harness.js';

test('cli.journeys-shout-journeys-fixture-foreground.the-cockpit-helper-starts-its-view: the cockpit helper starts its view in the foreground [C7,N26]', async t => {
  const box = machine();
  project(box, 'foreground-view');
  delete box.env.PULLBOARD_VIEW_FOREGROUND;
  const receipt = join(box.dir, 'view-processes.jsonl');
  const observer = join(box.dir, 'observe-view.mjs');
  // A preload observes the real spawned Node environment without replacing the CLI or server.
  writeFileSync(observer, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(1, 4), marker: process.env.PULLBOARD_VIEW_FOREGROUND ?? null }) + '\\n', { mode: 0o600 });\n`);
  box.env.NODE_OPTIONS = `${box.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(observer).href}`.trim();
  /** Read only the PIDs and marker observed by this fixture's actual Node children. */
  const observed = () => {
    try { const seen = new Map();
      // A worker thread inside the view repeats the preload under the same pid, so count processes, not imports.
      for (const line of readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean)) { const row = JSON.parse(line); if (!seen.has(row.pid)) seen.set(row.pid, row); }
      return [...seen.values()]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  /** Stop any owned child if a failed assertion interrupted the helper's normal cleanup. */
  t.after(() => {
    for (const { pid } of observed()) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  });
  const view = await startView(box);
  let children;
  try {
    children = observed();
    assert.equal(children.length, 1, 'the helper owns one foreground view process: ' + JSON.stringify(children));
    assert.equal(children[0].marker, '1', 'the actual spawned child receives the foreground marker');
    assert.doesNotThrow(() => process.kill(children[0].pid, 0), 'the owned child stays alive while serving');
  } finally {
    await view.stop();
  }
  assert.throws(() => process.kill(children[0].pid, 0), error => error.code === 'ESRCH',
    'stopping the helper removes its actual view process');
  await assert.rejects(fetchLive(view.link, { signal: AbortSignal.timeout(1_000) }),
    error => error.cause?.code === 'ECONNREFUSED', 'stopping the helper also closes the owned listener');
});
