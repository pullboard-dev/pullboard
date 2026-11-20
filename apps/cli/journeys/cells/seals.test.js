/** pullboard cells lists each cell as sealed or unsealed, and the commit that broke an unsealed one, read-only [C7,SC1,SC16]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { sealStatus } from '../../../../packages/gate/heavy.js';
import { recordSeal } from '../../../../packages/gate/heavy.js';
import { sealStoreFile } from '../../../../packages/gate/heavy.js';
import { apiHttpFixture } from '../../tests/fixtures/api.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

/** Write files into the fixture repo and commit them, returning the new commit id. */
function commit(box, files, message) {
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(box.root, file)), { recursive: true });
    writeFileSync(join(box.root, file), source);
  }
  const git = (...args) => runFixtureGit(args, { cwd: box.root, env: box.env, stdio: 'pipe', encoding: 'utf8' }).trim();
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

/** A repo with two cells sealed at their hashes, then one of them edited by a commit that is not the newest. */
function sealedAndEdited(t) {
  const box = apiHttpFixture(t);
  commit(box, {
    'packages/alpha/index.js': 'export const alpha = 1;\n',
    'packages/beta/index.js': 'export const beta = 1;\n',
  }, 'chore(fixture): two cells');
  const store = sealStoreFile(box.root);
  for (const row of sealStatus(box.root)) recordSeal(store, { package: row.package, hash: row.hash, receipts: [`receipt-${row.package}`], tests: [] });
  const changed = commit(box, { 'packages/beta/index.js': 'export const beta = 2;\n' }, 'chore(beta): change the beta answer');
  commit(box, { 'notes.txt': 'unrelated\n' }, 'docs(fixture): an unrelated note');
  return { box, changed };
}

test('cli.journeys-cells-seals.cells-json-reports-the-sealed-cell: clause 1: cells --json reports the sealed cell as sealed and the edited cell as unsealed with the commit that changed it [C7,SC1,SC16]', async t => {
  const { box, changed } = sealedAndEdited(t);
  const ran = await runCliInProcess(['cells', '--json'], { cwd: box.root, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const report = JSON.parse(ran.stdout);
  const cells = (report.result ?? report).cells;
  const row = name => cells.find(cell => cell.cell === name);
  assert.equal(row('packages/alpha').state, 'sealed');
  assert.deepEqual(row('packages/alpha').receipts, ['receipt-packages/alpha']);
  assert.equal(row('packages/alpha').changedBy, null);
  assert.equal(row('packages/beta').state, 'unsealed');
  assert.equal(row('packages/beta').changedBy, changed);
  assert.equal(row('packages/beta').changedSubject, 'chore(beta): change the beta answer');
  assert.deepEqual((report.result ?? report).unsealed, ['packages/beta']);
});

test('cli.journeys-cells-seals.cells-prints-one-line-per-cell: clause 2: cells prints one line per cell naming its state and the breaking commit [C7,SC1,SC16]', async t => {
  const { box, changed } = sealedAndEdited(t);
  const ran = await runCliInProcess(['cells'], { cwd: box.root, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /^packages\/alpha {2}sealed {2}[0-9a-f]{12} {2}by receipt-packages\/alpha$/mu);
  assert.match(ran.stdout, new RegExp(`^packages/beta  unsealed  [0-9a-f]{12}  broken by ${changed.slice(0, 12)} chore\\(beta\\): change the beta answer$`, 'mu'));
});

test('cli.journeys-cells-seals.after-an-unrelated-merge-an-unsealed: clause 1: after an unrelated merge, an unsealed cell names the commit that edited it, not the merge or a side-branch commit [C7,SC1,SC16]', async t => {
  const { box, changed } = sealedAndEdited(t);
  const git = (...args) => runFixtureGit(args, { cwd: box.root, env: box.env, stdio: 'pipe', encoding: 'utf8' }).trim();
  const trunk = git('rev-parse', '--abbrev-ref', 'HEAD');
  git('checkout', '-q', '-b', 'side', `${changed}~1`);
  commit(box, { 'side.txt': 'side work\n' }, 'docs(fixture): a side-branch note');
  git('checkout', '-q', trunk);
  git('merge', '--no-ff', '-q', '-m', 'chore(fixture): merge the side branch', 'side');
  const ran = await runCliInProcess(['cells', '--json'], { cwd: box.root, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const report = JSON.parse(ran.stdout);
  const beta = (report.result ?? report).cells.find(cell => cell.cell === 'packages/beta');
  assert.equal(beta.state, 'unsealed');
  assert.equal(beta.changedBy, changed);
  assert.equal(beta.changedSubject, 'chore(beta): change the beta answer');
});
