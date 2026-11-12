/** @pullboard-test-input apps/cli/pullboard.js apps/cli/src/io/command-docs/heartbeat.json docs/tools/update-docs.js packages/codemap/data/plan/cells.json packages/gate/data/tests/tiers.json packages/landing/src/io/derive.js */
/** @pullboard-test-input docs-tree */
/** Clean landing merges regenerate shared documentation before the real gate [B3,C7,V4]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../e2e.js';
import { runFixtureChild } from '../child.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Run the private committed tool, retaining complete child output on refusal. */
function command(box, cwd, ...args) {
  const result = runFixtureChild(process.execPath, [join(box.repo, 'apps/cli/pullboard.js'), ...args, '--no-next', '--json'],
    { cwd, env: box.env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, text: `${result.stdout}\n${result.stderr}`, stdout: result.stdout };
}

/** Require a genuine successful native command before using its result. */
function success(box, cwd, ...args) {
  const result = command(box, cwd, ...args);
  assert.equal(result.status, 0, result.text);
  return JSON.parse(result.stdout);
}

/** Import the full fixture in bounded normal commits, keeping every installed hook enabled. */
function commitFixture(box) {
  const files = [...new Set(box.git(box.repo, 'ls-files', '--modified', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))].sort();
  let chunk = [], bytes = 0, number = 0;
  /** Commit only the already measured bounded set, without changing any hook or scan budget. */
  const flush = () => {
    if (!chunk.length) return;
    box.git(box.repo, 'add', '--', ...chunk);
    box.git(box.repo, 'commit', '-q', '-m', `chore: import documentation fixture part ${++number}`);
    chunk = []; bytes = 0;
  };
  for (const file of files) {
    const size = readFileSync(join(box.repo, file)).length;
    assert.ok(size <= 1024 * 1024, `single fixture file needs a different normal setup: ${file}`);
    if (bytes + size > 1024 * 1024 || chunk.length === 100) flush();
    chunk.push(file); bytes += size;
  }
  flush();
  assert.equal(box.git(box.repo, 'status', '--porcelain'), '', 'the entire archived fixture is committed');
}

/** Copy only committed candidate code/data into the real private CLI/Git/SQLite project. */
function project(disableRefresh) {
  const box = helpers.project('node --test --test-reporter=tap web/docs.test.js');
  delete box.env.NODE_TEST_CONTEXT;
  const env = box.env;
  // The archive goes to a file, not a captured buffer: the committed tree outgrew any fixed in-memory limit.
  const tarball = join(box.dir, 'candidate-archive.tar');
  const archive = runFixtureChild('git', ['archive', '--output', tarball, 'HEAD', 'packages', 'apps', 'docs', 'skills', 'package.json',
    ':(exclude,glob)packages/*/tests/**', ':(exclude,glob)apps/*/tests/**', ':(exclude,glob)apps/*/journeys/**'],
    { cwd: join(import.meta.dirname, '../../../../..'), env });
  assert.equal(archive.status, 0, archive.context);
  const extracted = runFixtureChild('tar', ['-xf', tarball, '-C', box.repo], { env });
  assert.equal(extracted.status, 0, extracted.context);
  // The private project uses its own explicit gate, not this repository's generated test inventory.
  rmSync(join(box.repo, 'packages/gate/data/tests/tiers.json'), { force: true });
  // Its source layout is real, but this private project has no inherited cell plan or package test suite.
  rmSync(join(box.repo, 'packages/codemap/data/plan/cells.json'));
  const armed = join(box.dir, 'landing-gate-armed');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.gate = 'node --test --test-reporter=tap web/docs.test.js';
  config.lanes.web.owns.push('apps/cli/src/io/command-docs/');
  config.landing = { ...config.landing, manualOverride: true, publish: 'separate' };
  config.flakes = { rerun: false, quarantine: false };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2) + '\n');
  // Setup checks intentionally establish the item lifecycle, not generated-doc assurance.
  // The landing control arms the actual drift assertion only after native verification.
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/docs.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { existsSync } from 'node:fs';",
    "import { generatedDocDrift } from '../apps/cli/index.js';",
    "import { openBoard } from '../apps/lib/index.js';",
    `test('merged shared documentation is current [B3,C7,V4]', () => { if (existsSync(${JSON.stringify(armed)})) assert.deepEqual(generatedDocDrift(process.cwd(), undefined, { openBoard }), [], 'stale generated files: ' + generatedDocDrift(process.cwd(), undefined, { openBoard }).join(', ')); });`,
  ].join('\n') + '\n');
  if (disableRefresh) {
    const file = join(box.repo, 'packages/landing/src/io/derive.js');
    const source = readFileSync(file, 'utf8');
    const call = 'refreshLandingDocs(root);';
    assert.equal(source.split(call).length, 2, 'the private mutation removes exactly the actual landing refresh call');
    writeFileSync(file, source.replace(call, '// Mutation control: landing documentation refresh removed.'));
  }
  commitFixture(box);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return { ...box, armed };
}

/** A source-only declaration commits cleanly while its generated shared list remains unchanged. */
function verifiedDeclaration(box) {
  const item = success(box, box.repo, 'add', 'web', 'Document a clean landing declaration', '--specs', 'G1',
    '--criterion', 'the command declaration retains its name', '--check', "node -e \"if(require('./apps/cli/src/io/command-docs/heartbeat.json').name!=='heartbeat')process.exit(1)\"", '--route', 'strong').item.item_id;
  success(box, box.web, 'claim', String(item));
  const file = join(box.web, 'apps/cli/src/io/command-docs/heartbeat.json');
  const declaration = JSON.parse(readFileSync(file, 'utf8'));
  declaration.help += '  Clean landing documentation fixture.\n';
  writeFileSync(file, JSON.stringify(declaration, null, 2) + '\n');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): document a clean landing declaration [G1]');
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  assert.deepEqual(box.git(box.web, 'diff', '--name-only', 'main', head).split('\n'), ['apps/cli/src/io/command-docs/heartbeat.json']);
  success(box, box.web, 'submit', String(item));
  box.git(box.repo, 'switch', '-q', '--detach', head);
  try { success(box, box.repo, 'verify', String(item), 'accept', '--as', 'coordinator', '--note', 'Synthetic private lifecycle: declaration check only; landing documentation assertion is not yet armed.'); }
  finally { box.git(box.repo, 'switch', '-q', 'main'); }
  writeFileSync(box.armed, 'armed');
  // Main moves after the accept, so the submit receipt no longer answers for this landing's tree and its real gate runs [C7].
  writeFileSync(join(box.repo, 'main-moved-after-accept.txt'), 'main moved after the accept\n');
  box.git(box.repo, 'add', 'main-moved-after-accept.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: move main after the accept');
  return { item, head };
}

/** Read every actual retained landing gate log, without inventing a successful gate receipt. */
function evidence(report) {
  return (report.batch?.gateResults ?? []).map(result => result.logPath && existsSync(result.logPath)
    ? readFileSync(result.logPath, 'utf8') : '').join('\n');
}

/** Exercise one real landing outcome without changing its assertions. */
export function runLandingDocsRefresh(disabled) {
    const box = project(disabled);
    const entry = verifiedDeclaration(box);
    const before = box.git(box.repo, 'rev-parse', 'main');
    const oldDocs = box.git(box.repo, 'show', 'main:apps/cli/src/logic/help/additions.js');
    // This private persistent board is shared by separate native submit, verify and landing CLI processes.
    const outcome = command(box, box.repo, 'land');
    let report;
    try { report = JSON.parse(outcome.stdout); } catch { assert.fail(outcome.text); }
    const output = outcome.text + '\n' + evidence(report);
    assert.deepEqual(report.conflicts ?? [], [], 'the declaration merges without any textual conflict');
    if (disabled) {
      assert.deepEqual(report.landed ?? [], [], output);
      assert.match(output, /apps\/cli\/src\/logic\/help\/additions\.js/u, 'the actual failed landing names the stale shared file');
      assert.equal(box.git(box.repo, 'rev-parse', 'main'), before, 'stale documentation never advances trunk');
      assert.equal(success(box, box.repo, 'show', String(entry.item)).item_merged_commit, null);
    } else {
      assert.equal(outcome.status, 0, output);
      assert.deepEqual(report.landed, [entry.item], output);
      assert.equal(report.batch.state, 'landed');
      const tip = box.git(box.repo, 'rev-parse', 'main');
      assert.notEqual(tip, before);
      const regenerated = box.git(box.repo, 'show', `${tip}:apps/cli/src/logic/help/additions.js`);
      assert.notEqual(regenerated, oldDocs, 'landing commits actual regenerated bytes');
      assert.match(regenerated, /Clean landing documentation fixture/u);
      assert.equal(success(box, box.repo, 'show', String(entry.item)).item_merged_commit, tip);
      const checked = runFixtureChild(process.execPath, ['docs/tools/update-docs.js', '--check'], { cwd: box.repo, env: box.env, encoding: 'utf8' });
      assert.equal(checked.status, 0, checked.context);
      assert.equal(box.git(box.repo, 'rev-list', '--parents', '-n', '1', report.batch.items[0].merge).split(' ').length, 3,
        'the refreshed item remains an actual two-parent merge');
    }
}
