/** The view requires actual higher-level services before opening transports or writing exports [N26,C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { main } from '../src/cli-main.js';
import { cockpitPage } from '../src/cockpit.js';
import { exportView } from '../src/serve.js';
import { serveView } from '../src/serve.js';

/** Match a required service refusal without accepting unrelated setup or transport failures. */
function missingService(name) {
  return error => error.code === 'VIEW_SERVICE_REQUIRED' && error.message.includes(name);
}

/** Record the initial approved spec before init, as the real public-export fixtures do [N26]. */
function approvedViewFixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'SPEC.md'), helpers.SPEC);
  const model = box.env.PULLBOARD_MODEL;
  delete box.env.PULLBOARD_MODEL;
  try {
    const initialized = box.run(repo, 'init');
    assert.equal(initialized.code, 0, initialized.err || initialized.out);
  } finally {
    if (model !== undefined) box.env.PULLBOARD_MODEL = model;
  }
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ ...helpers.CONFIG, gate: 'true' }, null, 2));
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: prepare real view fixture');
  return { ...box, repo };
}

test('a live view refuses missing command or renderer services before listening [N26,C7]', async () => {
  await assert.rejects(serveView(), missingService('runCommand'));
  await assert.rejects(serveView({ runCommand: main }), missingService('renderPage'));
  await assert.rejects(serveView({ renderPage: cockpitPage }), missingService('runCommand'));
});

test('an export refuses missing services before reading a board or writing output [N26,C7]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-view-services-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'snapshot');
  await assert.rejects(exportView(directory, output), missingService('runCommand'));
  await assert.rejects(exportView(directory, output, { runCommand: main }), missingService('renderPage'));
  await assert.rejects(exportView(directory, output, { renderPage: cockpitPage }), missingService('runCommand'));
  assert.equal(existsSync(output), false, 'a refused export writes no snapshot');
});

/** @pullboard-test-input src/commands/view.js */
test('the actual CLI composition serves and exports a private real board [N26,C7]', t => {
  const box = approvedViewFixture(t);
  const module = new URL('../src/commands/view.js', import.meta.url).href;
  const output = join(box.dir, 'snapshot');
  const program = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serveView, exportView } from ${JSON.stringify(module)};
const root = ${JSON.stringify(box.repo)};
const view = await serveView({ port: 0, projectRoot: root });
try {
  const link = new URL(view.url);
  const headers = { 'x-pullboard-key': link.searchParams.get('k') };
  const page = await fetch(link.origin + '/', { headers });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/);
  const response = await fetch(link.origin + '/api/v1/boards', { headers });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).boards.map(board => board.root), [root]);
} finally { await view.close(); }
assert.equal(exportView.supportsPublicExport, true);
const destination = ${JSON.stringify(output)};
const result = await exportView(root, destination, { public: true });
assert.equal(result.path, destination);
assert.match(readFileSync(destination + '/index.html', 'utf8'), /<html/);
const listing = JSON.parse(readFileSync(destination + '/api/v1/boards.json', 'utf8'));
assert.equal(listing.boards.length, 1);
console.log('served and publicly exported the private fixture board');
`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', program], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /served and publicly exported the private fixture board/);
});
