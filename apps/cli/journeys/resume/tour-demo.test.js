/** The tour registers a labelled demo that view lists and forget removes (N10, N26); split from tour.test.js so the two run side by side on separate runners. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild as spawnSync } from '../../tests/fixtures/child.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  BIN, project, startView,
} = e2e;

/** Assert and remove only the outer command's exact final text action; retain every body byte. */
function withoutAction(text, action = 'pullboard next') {
  const footer = `next: ${action}\n`;
  assert.ok(text.endsWith('\n' + footer), 'the intended final action is present');
  return text.slice(0, -footer.length);
}

test('cli.journeys-resume-tour-demo.the-tour-registers-a-labelled-demo: the tour registers a labelled demo that view lists and forget removes [N10, N26]', async () => {
  const box = project();
  const tourEnv = { ...box.env, TMPDIR: box.dir, HOME: box.dir };
  delete tourEnv.PULLBOARD_MODEL;
  // Process-level case kept as a process: the tour demo owns its server child and port.
  const result = spawnSync(process.execPath, [BIN, 'tour'], {
    cwd: box.dir,
    env: tourEnv,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(withoutAction(result.stdout, 'pullboard view').trimEnd().split('\n').at(-1), 'see it: pullboard view');
  assert.equal(result.stdout.match(/^next: pullboard view$/gmu)?.length, 1, 'the outer command retains its action');
  assert.doesNotMatch(result.stdout, /^ +next: pullboard next$/mu, 'nested child commands add no fallback footers');
  const demoRoot = /Look around: cd (\S+) && pullboard log/.exec(result.stdout)?.[1];
  assert.ok(demoRoot, 'the retained demo path is printed');
  const registered = JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'projects.json'), 'utf8')).projects;
  assert.deepEqual(registered.map(({ root, name }) => [root, name]), [[box.repo, 'repo'], [demoRoot, 'demo']]);

  const view = await startView(box, box.repo);
  try {
    const listing = await fetchFresh(`${view.base}/api/v1/boards`, { headers: { 'x-pullboard-key': view.key } });
    assert.equal(listing.status, 200);
    assert.deepEqual((await listing.json()).boards.map(({ root, name }) => [root, name]), [[box.repo, 'repo'], [demoRoot, 'demo']]);
    const forgotten = (await box.runLocal(box.dir, 'forget', demoRoot));
    assert.equal(forgotten.code, 0, forgotten.err);
    assert.match(forgotten.out, /forgot/);
    const after = await fetchFresh(`${view.base}/api/v1/boards`, { headers: { 'x-pullboard-key': view.key } });
    assert.deepEqual((await after.json()).boards.map(({ root, name }) => [root, name]), [[box.repo, 'repo']]);
  } finally {
    await view.stop();
  }
});
