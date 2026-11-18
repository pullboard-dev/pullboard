/** The runner's installed service code is rebuilt from a trunk commit's closure, and a failed rebuild leaves it whole [P7,#10824]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runnerCodeRefresh } from '../../../src/io/service.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';

const ENTRY = 'svc/entry.js';

/** A trunk with two commits whose service closure differs, an installed app folder holding the first, and the files beside it. */
function runner(t) {
  const { root: trunk } = privateFixtureFiles('pullboard-refresh-trunk-');
  const { root: base } = privateFixtureFiles('pullboard-refresh-base-');
  t.after(() => { for (const folder of [trunk, base]) rmSync(folder, { recursive: true, force: true }); });
  const sh = (...args) => runFixtureGit(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd: trunk });
  sh('init', '-q', '-b', 'main');
  mkdirSync(join(trunk, 'svc'));
  writeFileSync(join(trunk, ENTRY), "import { word } from './lib.js';\nexport const said = word;\n");
  writeFileSync(join(trunk, 'svc/lib.js'), "export const word = 'one';\n");
  writeFileSync(join(trunk, 'unrelated.txt'), 'not imported\n');
  sh('add', '.');
  sh('commit', '-q', '-m', 'one');
  const first = sh('rev-parse', 'HEAD');
  writeFileSync(join(trunk, 'svc/lib.js'), "export const word = 'two';\n");
  writeFileSync(join(trunk, 'svc/more.js'), "export const more = 2;\n");
  writeFileSync(join(trunk, ENTRY), "import { word } from './lib.js';\nimport { more } from './more.js';\nexport const said = word + more;\n");
  sh('add', '.');
  sh('commit', '-q', '-m', 'two');
  const second = sh('rev-parse', 'HEAD');
  const app = join(base, 'serve/app');
  mkdirSync(join(app, 'svc'), { recursive: true });
  writeFileSync(join(app, ENTRY), "import { word } from './lib.js';\nexport const said = word;\n");
  writeFileSync(join(app, 'svc/lib.js'), "export const word = 'one';\n");
  writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
  const beside = { 'serve/board.key': 'secret\n', 'serve/dev.pullboard.runner-serve.plist': '<plist/>\n', 'serve/serve.log': 'log line\n' };
  for (const [path, text] of Object.entries(beside)) writeFileSync(join(base, path), text);
  const refresher = (options = {}) => runnerCodeRefresh({ app, store: join(trunk, '.git'), entry: ENTRY, ...options });
  return { app, base, beside, first, second, refresher };
}

const said = async app => (await import(`${pathToFileURL(join(app, ENTRY)).href}?${Math.random()}`)).said;

test('runners.refresh.n10824-clause-1-changed-answers-by-closure: #10824 clause 1: changed(commit) is true for a trunk commit whose serviceFiles closure differs from the installed app folder, and false when it matches [P7]', async t => {
  const { first, second, refresher } = runner(t);
  const port = refresher();
  assert.equal(await port.changed(first), false);
  assert.equal(await port.changed(second), true);
});

test('runners.refresh.n10824-clause-2-refresh-swaps-the-closure: #10824 clause 2: refresh(commit) writes the commit\'s closure over the app folder through app.next and a rename, leaving board.key, the plist and serve.log as they were [P7]', async t => {
  const { app, base, beside, second, refresher } = runner(t);
  const port = refresher();
  assert.equal(await port.refresh(second), true);
  assert.equal(await said(app), 'two2');
  assert.equal(readFileSync(join(app, 'svc/more.js'), 'utf8'), 'export const more = 2;\n');
  assert.equal(existsSync(join(app, 'unrelated.txt')), false);
  assert.equal(readFileSync(join(app, 'package.json'), 'utf8'), '{ "type": "module" }\n');
  for (const [path, text] of Object.entries(beside)) assert.equal(readFileSync(join(base, path), 'utf8'), text, path);
  assert.equal(existsSync(`${app}.next`), false);
  assert.equal(existsSync(`${app}.prev`), false);
  assert.equal(await port.changed(second), false);
  assert.equal(await port.refresh(second), false);
});

test('runners.refresh.n10824-clause-3-a-failed-refresh-leaves: #10824 clause 3: a refresh that fails part way leaves the old app folder whole and runnable [P7]', async t => {
  const { app, second, refresher } = runner(t);
  let writes = 0;
  const write = (path, text) => {
    writes += 1;
    if (writes === 2) throw new Error('disk full');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  await assert.rejects(refresher({ write }).refresh(second), /disk full/u);
  assert.ok(writes >= 2, 'the failure came after a file was written');
  assert.equal(readFileSync(join(app, 'svc/lib.js'), 'utf8'), "export const word = 'one';\n");
  assert.equal(existsSync(join(app, 'svc/more.js')), false);
  assert.equal(existsSync(`${app}.next`), false);
  assert.equal(await said(app), 'one');
});
