/** The row-age worker starts even when the view runs under node --input-type=module -e [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { cellProject } from '../../../../../packages/store/tests/fixtures/cell.js';

const KIT = pathToFileURL(new URL('../../../../cli/tests/fixtures/child.js', import.meta.url).pathname).href;
const SERVE = pathToFileURL(new URL('../../../src/io/serve.js', import.meta.url).pathname).href;

test('clause 1: a view started through node --input-type=module -e still refreshes row ages in its worker [C7]', t => {
  const project = cellProject(t, { real: true });
  const script = `
    import { projectState } from ${JSON.stringify(SERVE)};
    import { openKitBoard } from ${JSON.stringify(KIT)};
    const options = { board: openKitBoard(${JSON.stringify(project.boardFile)}), rowAgesLater: true };
    const first = projectState(${JSON.stringify(project.repo)}, options);
    const deadline = Date.now() + 20000;
    let state = first;
    while (Date.now() < deadline && Object.values(state.rowAgesAt).every(at => at === null)) {
      await new Promise(done => setTimeout(done, 100));
      state = projectState(${JSON.stringify(project.repo)}, options);
    }
    console.log(JSON.stringify({ first: Object.values(first.rowAgesAt), later: Object.values(state.rowAgesAt) }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  const { first, later } = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.ok(first.every(at => at === null), 'the first read walks nothing');
  assert.ok(later.length > 0 && later.every(at => typeof at === 'string'), 'the worker refreshed the ages for HEAD');
});
