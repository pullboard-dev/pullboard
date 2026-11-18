/** @pullboard-test-input source-cell sentinels gate */
/** @pullboard-world-pin: clause 1 reads the sentinel serve source and the committed ceiling to prove no apps/ path remains. */
/** The view's sentinel runs the CLI entry its caller names and its package names no apps/ path, so its package-to-app ceiling row is gone [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { startServeSentinel } from '../../index.js';

const { root } = privateFixtureFiles('sentinel-serve-cli-');
after(() => rmSync(root, { recursive: true, force: true }));

test('sentinels.serve-cli.scan-child-runs-passed-entry: clause 1: the scan child runs the CLI entry the caller passes, with the health-only words [C7]', async () => {
  const log = join(root, 'argv.json');
  const entry = join(root, 'entry.js');
  writeFileSync(entry, `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  let tick;
  const observer = startServeSentinel({ projectRoot: root, cli: entry, enabled: () => true, every: callback => { tick = callback; return { unref() {} }; },
    cancel: () => {}, liveEvery: () => ({ unref() {} }), liveCancel: () => {}, canary: () => ({ close: async () => {} }) });
  await tick();
  await observer.close();
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [['sentinel', 'run', '--health-only', '--json']]);
});

test('sentinels.serve-cli.serve-names-no-apps-path: clause 1: serve.js names no apps/ path and the committed ceiling holds no row for it [C7]', () => {
  assert.doesNotMatch(readFileSync(new URL('../../src/io/serve.js', import.meta.url), 'utf8'), /apps\//u);
  const ceilings = JSON.parse(readFileSync(new URL('../../../gate/data/ceilings/cells-edges.json', import.meta.url), 'utf8'));
  assert.equal(ceilings.packageApps['packages/sentinels/src/io/serve.js'], undefined);
});
