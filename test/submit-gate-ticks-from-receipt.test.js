/** Submit never waits on a pre-proof: a [test] clause naming a test file is ticked by the gate's own receipt [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { TIMING_RUN_ID_ENV } from '../packages/gate/index.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { joinFixtureSeat } from './testkit-fixture.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const RUN = 'node --test --test-reporter=./web/outcome-reporter.js web/gate-ticks.test.js';
const CRITERION = 'The page meets its bar:\n1) web/gate-ticks.test.js proves the heading [test]\n2) web/gate-ticks.test.js proves the count [test]';

/** Run a Pullboard command and fail with its full output when it is refused. */
function ok(box, cwd, ...args) {
  const result = box.run(cwd, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}\n${result.out}`);
  return result;
}

/** Commit fixture files with the repository's real Git hooks. */
function commit(box, cwd, message) {
  box.git(cwd, 'add', '-A');
  box.git(cwd, 'commit', '-q', '-m', message);
}

/** Install a TAP reporter that records real per-test gate outcomes in the receipt. */
function outcomeReporter(box) {
  const gate = new URL('../packages/gate/index.js', import.meta.url).href;
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/outcome-reporter.js'), [
    "import { tap } from 'node:test/reporters';",
    `import { testOutcomeCollector, formatTestOutcomes } from ${JSON.stringify(gate)};`,
    'export default async function* report(events) {',
    '  const collector = testOutcomeCollector(process.cwd());',
    '  let count = null;',
    '  async function* observe() {',
    '    for await (const event of events) {',
    '      collector.observe(event);',
    "      if (event.type === 'test:summary') count = event.data.counts.tests;",
    '      yield event;',
    '    }',
    '  }',
    '  for await (const chunk of tap(observe())) yield chunk;',
    `  yield formatTestOutcomes(process.env[${JSON.stringify(TIMING_RUN_ID_ENV)}], collector.finish(count !== null, count));`,
    '}',
    '',
  ].join('\n'));
}

/** A claimed web item with the given criterion and a committed test file whose second case may fail. */
function builderItem(criterion, { failing = false, brief = 'Files:\n- web/page.html\nTest:\n- web/gate-ticks.test.js' } = {}) {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  delete box.env.NODE_TEST_CONTEXT;
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.submitGate = 'landing';
  config.affectedTests = RUN;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  outcomeReporter(box);
  commit(box, box.repo, 'chore: record gate tick runner');
  const builder = join(box.dir, 'web-builder');
  box.git(box.repo, 'worktree', 'add', '-q', builder, '-b', 'web/gate-ticks');
  joinFixtureSeat(box, builder, 'web');
  const added = JSON.parse(ok(box, box.repo, 'add', 'web', 'Gate ticks its own clauses', '--specs', 'G1', '--criterion', criterion,
    '--check', RUN, '--route', 'strong', '--brief', brief, '--json').out);
  const id = added.item.item_id;
  ok(box, builder, 'claim', String(id));
  mkdirSync(join(builder, 'web'), { recursive: true });
  writeFileSync(join(builder, 'web/page.html'), '<h1>Dashboard</h1><p>Count: 3</p>\n');
  writeFileSync(join(builder, 'web/gate-ticks.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    "const page = readFileSync('web/page.html', 'utf8');",
    "test('the heading is present', () => assert.match(page, /Dashboard/u));",
    `test('the count appears', () => assert.match(page, ${failing ? '/Count: 4/u' : '/Count: 3/u'}));`,
    '',
  ].join('\n'));
  commit(box, builder, 'feat(web): gate ticks its own clauses [G1]');
  return { box, builder, id };
}

/** The tick notes the item's thread carries, as text. */
function tickNotes(box, id) {
  const shown = JSON.parse(ok(box, box.repo, 'show', String(id), '--detail', '--json').out);
  return JSON.stringify(shown).match(/clause \d \[test\][^"]*/gu) ?? [];
}

test('clause 1 and 2: a [test] clause naming a test file submits with no pre-proof tick, and the green gate ticks it with its named cases [C7,V4]', { timeout: 300_000 }, () => {
  const { box, builder, id } = builderItem(CRITERION);
  const submitted = box.run(builder, 'submit', String(id), '--no-next', '--json');
  assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
  assert.doesNotMatch(submitted.err + submitted.out, /CLAUSE_UNTICKED/u, 'no pre-proof tick was needed');
  assert.equal(JSON.parse(submitted.out).gate.green, true, 'the gate ran the named file');
  const ticks = tickNotes(box, id);
  assert.equal(ticks.length, 2, `the gate ticked each clause: ${ticks.join(' | ')}`);
  assert.match(ticks[0], /^clause 1 \[test\]: .*web\/gate-ticks\.test\.js.*the heading is present/u);
  assert.match(ticks[1], /^clause 2 \[test\]: .*web\/gate-ticks\.test\.js.*the count appears/u);
});

test('clause 2: a red gate leaves the clause unticked and returns the item [C7,V4]', { timeout: 300_000 }, () => {
  const { box, builder, id } = builderItem(CRITERION, { failing: true });
  const submitted = box.run(builder, 'submit', String(id), '--no-next', '--json');
  assert.notEqual(submitted.code, 0, 'a red gate does not submit');
  assert.doesNotMatch(submitted.err + submitted.out, /CLAUSE_UNTICKED/u);
  assert.deepEqual(tickNotes(box, id), [], 'a red gate ticks nothing');
  assert.equal(JSON.parse(ok(box, box.repo, 'show', String(id), '--json').out).item_status ?? JSON.parse(ok(box, box.repo, 'show', String(id), '--json').out).status, 'claimed', 'the item stays with its builder');
});

test('clause 3: a measurement clause and a test clause naming no file still refuse CLAUSE_UNTICKED until a fact is recorded [C7,V4]', { timeout: 300_000 }, () => {
  const { box, builder, id } = builderItem('The page meets its bar:\n1) web/gate-ticks.test.js proves the heading [test]\n2) the page loads under 2 s [measurement]\n3) the count is right [test]', { brief: 'Files:\n- web/page.html\nChange:\n- Keep the page valid.' });
  const refused = box.run(builder, 'submit', String(id), '--no-next');
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /CLAUSE_UNTICKED/u);
  assert.match(refused.err, /clause 2 \(the page loads under 2 s/u, 'the measurement clause needs a fact');
  assert.match(refused.err, /clause 3 \(the count is right/u, 'a test clause naming no file needs a fact');
  assert.doesNotMatch(refused.err, /clause 1 \(/u, 'the named-file clause needs none');
});
