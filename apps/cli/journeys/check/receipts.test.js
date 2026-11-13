/** Each static and doctrine check runs once per tree; submit, review and landing cite its receipt [V4,C7]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { statSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runRuleCheck } from '../../../../packages/doctrine/index.js';
import { checkReceiptKey } from '../../../../packages/git/index.js';
import { readCheckReceipt } from '../../../../packages/git/index.js';
import { writeCheckReceipt } from '../../../../packages/git/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

/** Demand real command success and its versioned result. */
function ok(result) { assert.equal(result.code, 0, result.out + result.err); return JSON.parse(result.out); }

/**
 * Run one in-process call while tapping the process's real stderr, where check citations are written.
 *
 * Why: a spawned CLI showed those lines in its own stderr; in this process they go to the real stream.
 *
 * @param {() => Promise<{ out: string, err: string }>} call - The in-process CLI call.
 * @returns {Promise<object>} The call's result with the tapped lines appended to its err.
 */
async function withStderrTap(call) {
  const lines = [];
  const previous = process.stderr.write;
  process.stderr.write = value => { lines.push(String(value)); return true; };
  try {
    const result = await call();
    return { ...result, err: `${result.err}${lines.join('')}` };
  } finally { process.stderr.write = previous; }
}

/** How many times a logged check ran: each run appends one four-byte line. */
function runs(file) { return existsSync(file) ? statSync(file).size / 4 : 0; }

/** A web item whose static check and doctrine rule log every run, and whose item check is red until armed. */
async function project(helpers, { staticCommand = 'node static.cjs', doctrineCommand = 'node doctrine.cjs' } = {}) {
  const box = helpers.project('true');
  const logs = { static: join(box.dir, 'static-runs.log'), doctrine: join(box.dir, 'doctrine-runs.log') };
  const armed = join(box.dir, 'item-check-green');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...helpers.CONFIG, gate: 'true', staticChecks: staticCommand }, null, 2));
  writeFileSync(join(box.repo, 'static.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(logs.static)}, 'ran\\n');\n`);
  writeFileSync(join(box.repo, 'doctrine.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(logs.doctrine)}, 'ran\\n');\n`);
  writeFileSync(join(box.repo, 'check.cjs'), `process.exit(require('node:fs').existsSync(${JSON.stringify(armed)}) ? 0 : 1);\n`);
  appendFileSync(join(box.repo, 'DOCTRINE.md'), `\n## Q · Quality\n- Q1 [approved, must] Every doctrine run is counted. | gate: check ${doctrineCommand} | count: 0\n`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: logged static and doctrine checks [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  ok(await fixtureAdd(box.runLocal, box.repo, 'web', 'Build the page', '--criterion', 'the page is built', '--brief', 'Files: web/page.txt\nTest: the check passes once the page file exists', '--route', 'mid', '--check', 'node check.cjs', '--json'));
  ok(await box.runLocal(box.web, 'claim', '1', '--json'));
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/page.txt'), 'built\n');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): build the page [G1]');
  return { box, logs, armed };
}

test('a second submit of an unchanged tree runs no static or doctrine check and cites the receipts [V4,C7]', { timeout: 240_000 }, async (t) => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const { box, logs, armed } = await project(helpers);
  rmSync(armed, { force: true });
  const red = (await box.runLocal(box.web, 'submit', '1', '--json'));
  assert.notEqual(red.code, 0, 'the item check is red on the first submit');
  assert.equal(runs(logs.static), 1, 'the static check ran once');
  // The doctrine hold measures main's problems once (since #2575) and the candidate once: two runs, then none.
  assert.equal(runs(logs.doctrine), 2, 'the doctrine check ran once at main and once at the candidate');
  writeFileSync(armed, 'green\n');
  const second = await withStderrTap(() => box.runLocal(box.web, 'submit', '1'));
  assert.equal(second.code, 0, second.out + second.err);
  assert.equal(runs(logs.static), 1, 'the unchanged tree runs no static check again');
  assert.equal(runs(logs.doctrine), 2, 'the unchanged tree runs no doctrine check again');
  assert.match(second.out + second.err, /static check reused receipt [0-9a-f-]{36} for tree [0-9a-f]{12}/u, 'submit cites the static receipt');
  assert.match(second.out + second.err, /doctrine-hold check reused receipt [0-9a-f-]{36} for tree [0-9a-f]{12}/u, 'submit cites the doctrine receipt');
  // A reviewer checking the same submitted tree from its own worktree cites the same receipt.
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const review = join(box.dir, 'api-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  ok(await fixtureJoin(box.runLocal, review, 'api', '--model', 'Fixture reviewer', '--json'));
  const checked = await withStderrTap(() => box.runLocal(review, 'check', '1', '--yes'));
  assert.equal(checked.code, 0, checked.out + checked.err);
  assert.equal(runs(logs.static), 1, 'review on the same tree runs no static check');
  assert.match(checked.out + checked.err, /static check reused receipt/u, 'review cites the receipt');
});

test('a changed file, check code or config re-runs the check; the same tree in another worktree reuses it [V4,C7]', { timeout: 240_000 }, async (t) => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const { box, logs } = await project(helpers);
  const config = { staticChecks: 'node static.cjs', gate: 'true' };
  const spec = (root, extra = {}) => checkReceiptKey(root, { kind: 'static', definition: config.staticChecks, config, ...extra });
  const first = spec(box.web);
  assert.ok(first, 'a clean checkout has a key');
  writeCheckReceipt(box.web, first, { by: 'web-1' });
  assert.ok(readCheckReceipt(box.web, first), 'the receipt is read back for the same tree');
  // A landing worktree at the same composed tree reads the receipt the submit wrote.
  const landing = join(box.dir, 'landing');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', landing, box.git(box.web, 'rev-parse', 'HEAD'));
  assert.equal(readCheckReceipt(landing, spec(landing))?.id, readCheckReceipt(box.web, first).id, 'the same tree in another worktree reuses the receipt');
  assert.equal(runRuleCheck(box.web, 'node doctrine.cjs').broken, '');
  assert.equal(runRuleCheck(landing, 'node doctrine.cjs').broken, '');
  assert.equal(runs(logs.doctrine), 1, 'landing reuses the submit tree doctrine observation');
  // Negative controls: a changed config, a changed check definition, a dirty file and a changed tree each miss.
  assert.equal(readCheckReceipt(box.web, checkReceiptKey(box.web, { kind: 'static', definition: config.staticChecks, config: { ...config, gate: 'npm test' } })), null, 'a changed config re-runs');
  assert.equal(readCheckReceipt(box.web, checkReceiptKey(box.web, { kind: 'static', definition: 'node static.cjs --strict', config })), null, 'a changed check re-runs');
  writeFileSync(join(box.web, 'web/page.txt'), 'changed\n');
  assert.equal(spec(box.web), null, 'an uncommitted change never reads or writes a receipt');
  box.git(box.web, 'commit', '-q', '-am', 'feat(web): change the page [G1]');
  assert.equal(readCheckReceipt(box.web, spec(box.web)), null, 'a changed tree re-runs');
  // The code that runs a check is part of its definition: changing it re-runs the check on the same tree.
  const runner = join(box.dir, 'runner-code.js');
  const helper = join(box.dir, 'runner-helper.js');
  writeFileSync(helper, '// helper v1\n');
  writeFileSync(runner, "import './runner-helper.js'; // runner v1\n");
  const before = spec(box.web, { code: [runner] });
  writeCheckReceipt(box.web, before, { by: 'web-1' });
  assert.ok(readCheckReceipt(box.web, spec(box.web, { code: [runner] })), 'unchanged runner code reuses');
  writeFileSync(helper, '// helper v2\n');
  assert.equal(readCheckReceipt(box.web, spec(box.web, { code: [runner] })), null, 'a transitive runner helper change re-runs');
  writeFileSync(runner, "import './runner-helper.js'; // runner v2\n");
  assert.equal(readCheckReceipt(box.web, spec(box.web, { code: [runner] })), null, 'changed check code re-runs');
});


test('a configured external checker changing its real implementation invalidates the doctrine receipt [V4,C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const { box } = await project(helpers);
  const outside = mkdtempSync(join(tmpdir(), 'pullboard-check-code-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const script = join(outside, 'check.cjs');
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  const counter = join(outside, 'runs.log');
  writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'ran\\n');\n`);
  assert.deepEqual(runRuleCheck(box.web, command).problems, []);
  assert.deepEqual(runRuleCheck(box.web, command).problems, []);
  assert.equal(runs(counter), 1, 'an unchanged external checker runs only once');
  writeFileSync(script, "process.stdout.write('new refusal\\n'); process.exit(1);\n");
  // Process-level case: runs the checker script itself, not the CLI, to prove its real output.
  const actual = runFixtureChild(process.execPath, [script], { cwd: box.web, encoding: 'utf8' });
  assert.equal(actual.status, 1);
  assert.equal(actual.stdout, 'new refusal\n');
  assert.deepEqual(runRuleCheck(box.web, command).problems, ['new refusal']);
});

test('unchanged-tree submits invalidate static and aggregate doctrine receipts when external checker code changes [V4,C7]', async t => {
  for (const stage of ['static', 'doctrine']) {
    const helpers = createE2eHelpers();
    t.after(helpers.cleanup);
    const outside = mkdtempSync(join(tmpdir(), 'pullboard-submit-check-code-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const script = join(outside, 'check.cjs');
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    const counter = join(outside, 'runs.log');
    writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'ran\\n');\n`);
    const { box, armed } = await project(helpers, { [`${stage}Command`]: command });
    assert.notEqual((await box.runLocal(box.web, 'submit', '1')).code, 0, 'the first item check is red after the guards pass');
    assert.notEqual((await box.runLocal(box.web, 'submit', '1')).code, 0, 'an unchanged submit still proves its red item check');
    // The doctrine hold also measures main once, so its guard runs twice on the first submit and never again.
    assert.equal(runs(counter), stage === 'doctrine' ? 2 : 1, 'the unchanged external guard is reused');
    writeFileSync(script, "process.stdout.write('changed checker\\n'); process.exit(1);\n");
    writeFileSync(armed, 'green\n');
    const second = await withStderrTap(() => box.runLocal(box.web, 'submit', '1'));
    // A rising doctrine count is a report-only trial refusal (13532c41d): it prints "would refuse" and lets the submit go on.
    if (stage === 'static') assert.notEqual(second.code, 0, 'changed checker bytes cannot reuse a successful guard');
    assert.match(second.out + second.err, stage === 'static' ? /GATE_RED/u : /would refuse RATCHET_ROSE/u);
    assert.match(second.out + second.err, /changed checker/u);
  }
});

test('external literal module dependencies are part of a checker definition [V4,C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const { box } = await project(helpers);
  const outside = mkdtempSync(join(tmpdir(), 'pullboard-check-dependency-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const script = join(outside, 'check.cjs');
  const dependency = join(outside, 'rule.cjs');
  writeFileSync(script, "require('./loader.jsx');\n");
  writeFileSync(join(outside, 'loader.jsx'), "require('./rule.cjs');\n");
  writeFileSync(dependency, 'process.exit(0);\n');
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  assert.deepEqual(runRuleCheck(box.web, command).problems, []);
  writeFileSync(dependency, "console.log('changed dependency'); process.exit(1);\n");
  assert.deepEqual(runRuleCheck(box.web, command).problems, ['changed dependency']);
  assert.equal(checkReceiptKey(box.web, { kind: 'doctrine', definition: 'node "$CHECKER"', config: {} }), null, 'an opaque command never reuses a receipt');
  const directory = join(outside, 'rules');
  mkdirSync(directory);
  writeFileSync(join(directory, 'package.json'), '{"main":"actual.cjs"}\n');
  writeFileSync(join(directory, 'index.js'), 'process.exit(0);\n');
  writeFileSync(join(directory, 'actual.cjs'), 'process.exit(0);\n');
  writeFileSync(script, "require('./rules');\n");
  assert.deepEqual(runRuleCheck(box.web, command).problems, []);
  assert.equal(checkReceiptKey(box.web, { kind: 'doctrine', definition: command, config: {} }), null, 'package directory loaders stay uncached rather than guessing index.js');
  writeFileSync(join(directory, 'actual.cjs'), "console.log('changed package entry'); process.exit(1);\n");
  assert.deepEqual(runRuleCheck(box.web, command).problems, ['changed package entry']);
});


test('POSIX PATH checker definitions follow the executable the shell actually selects [V4,C7]', { skip: process.platform === 'win32' }, async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const { box } = await project(helpers);
  const outside = mkdtempSync(join(tmpdir(), 'pullboard-check-path-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const skipped = join(outside, 'skipped');
  const selected = join(outside, 'selected');
  mkdirSync(skipped);
  mkdirSync(selected);
  writeFileSync(join(skipped, 'receipt-probe'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(skipped, 'receipt-probe'), 0o644);
  const script = join(selected, 'receipt-probe');
  writeFileSync(script, '#!/bin/sh\nexit 0\n');
  chmodSync(script, 0o755);
  const previous = process.env.PATH;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
  process.env.PATH = `${skipped}:${selected}:${previous ?? ''}`;
  assert.deepEqual(runRuleCheck(box.web, 'receipt-probe').problems, []);
  writeFileSync(script, "#!/bin/sh\nprintf 'changed executable\\n'\nexit 1\n");
  assert.deepEqual(runRuleCheck(box.web, 'receipt-probe').problems, ['changed executable']);
});


test('shell wrappers and tracked constant loaders include changed external helpers [V4,C7]', async t => {
  for (const wrapper of ['shell', 'shell-without-extension', 'tracked-loader']) {
    const helpers = createE2eHelpers();
    t.after(helpers.cleanup);
    const { box } = await project(helpers);
    const script = join(box.dir, 'wrapped-rule.cjs');
    const counter = join(box.dir, 'wrapped-runs.log');
    writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'ran\\n');\n`);
    let command;
    if (wrapper.startsWith('shell')) {
      const shell = join(box.dir, wrapper === 'shell' ? 'wrapper.sh' : 'wrapper');
      writeFileSync(shell, `${wrapper === 'shell' ? '#!/bin/sh\n' : ''}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`);
      command = `/bin/sh ${JSON.stringify(shell)}`;
    } else {
      writeFileSync(join(box.web, 'web/loader.cjs'), `const checker = ${JSON.stringify(script)}; require(checker);\n`);
      box.git(box.web, 'add', 'web/loader.cjs');
      box.git(box.web, 'commit', '-q', '-m', 'test: tracked loader [G1]');
      command = 'node web/loader.cjs';
    }
    assert.deepEqual(runRuleCheck(box.web, command).problems, []);
    assert.deepEqual(runRuleCheck(box.web, command).problems, []);
    assert.equal(runs(counter), 1, `${wrapper} is reused unchanged`);
    writeFileSync(script, "console.log('changed wrapped rule'); process.exit(1);\n");
    assert.deepEqual(runRuleCheck(box.web, command).problems, ['changed wrapped rule'], `${wrapper} cannot hide changed bytes`);
  }
});

test('configuration receipts cover both files and report changed parts [V4,C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const { box } = await project(helpers);
  const spec = () => checkReceiptKey(box.repo, { kind: 'config-proof', definition: 'node static.cjs', config: {} });
  const first = spec();
  writeCheckReceipt(box.repo, first);
  assert.ok(readCheckReceipt(box.repo, spec()));
  writeFileSync(join(box.repo, 'package.json'), '{"type":"commonjs","checkerMode":"strict"}\n');
  box.git(box.repo, 'add', 'package.json');
  box.git(box.repo, 'commit', '-q', '-m', 'test: config change [G1]');
  const changed = spec();
  assert.notEqual(changed.configDigest, first.configDigest, 'package config is fingerprinted independently of the tree');
  const lines = [];
  const previous = process.stderr.write;
  process.stderr.write = value => { lines.push(String(value)); return true; };
  try { assert.equal(readCheckReceipt(box.repo, changed), null); }
  finally { process.stderr.write = previous; }
  assert.match(lines.join(''), /tree changed; config changed/u);
  writeCheckReceipt(box.repo, changed);
  const config = JSON.parse(helpers.CONFIG ? JSON.stringify(helpers.CONFIG) : '{}');
  config.staticChecks = 'node static.cjs --strict';
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  box.git(box.repo, 'commit', '-q', '-am', 'test: checker config change [G1]');
  assert.notEqual(spec().configDigest, changed.configDigest, 'pullboard config is independently fingerprinted');
});
