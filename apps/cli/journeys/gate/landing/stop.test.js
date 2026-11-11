/** @pullboard-test-input source-tree */
/** Landing cancellation retains the real assertion in CLI and full-log reports [C7,V4]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const runner = resolve(import.meta.dirname, '../../../../../packages/gate/src/io/run/tests.js');

/** Run only three private fixture files; the held earlier file makes the failure out of order. */
test("a landing stop keeps the failing test's report [C7,V4]", () => {
  const box = e2e.sandbox();
  const root = join(box.dir, 'report-project');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  const initialized = box.run(root, 'init');
  assert.equal(initialized.code, 0, initialized.err || initialized.out);
  const started = join(box.dir, 'held-started');
  const queued = join(box.dir, 'queued-started');
  const tests = join(root, 'test');
  mkdirSync(tests);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(tests, '01-held.test.js'), `import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('the earlier file is held', async t => {
  const held = setInterval(() => {}, 1000);
  t.after(() => clearInterval(held));
  writeFileSync(${JSON.stringify(started)}, 'ready');
  await new Promise(resolve => t.signal.addEventListener('abort', resolve, { once: true }));
});
`);
  writeFileSync(join(tests, '02-failure.test.js'), `import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
test('later assertion owns its report', async () => {
  while (!existsSync(${JSON.stringify(started)})) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(2, 1, 'landing assertion report kept');
});
`);
  writeFileSync(join(tests, '03-queued.test.js'), `import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('queued work must not start', () => writeFileSync(${JSON.stringify(queued)}, 'started'));
`);
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  config.gate = [process.execPath, runner].map(quote).join(' ') + ' --test-concurrency=2 test/01-held.test.js test/02-failure.test.js test/03-queued.test.js';
  config.landingShards = 1;
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify(config, null, 2));
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore: prepare a landing report fixture');
  const result = box.run(root, 'gate', '--landing', '--json');
  assert.equal(result.code, 1, result.err || result.out);
  assert.equal(existsSync(started), true, 'the first file was active before the assertion');
  assert.equal(existsSync(queued), false, 'early stopping still prevents queued work');
  const report = JSON.parse(result.out).report;
  const log = readFileSync(resolve(root, box.git(root, 'rev-parse', '--git-path', 'pullboard-gate.log').trim()), 'utf8');
  console.log(JSON.stringify({ report, fullLog: log }));
  for (const [where, output] of [['gate output', report], ['full log', log]]) {
    assert.match(output, /not ok \d+ - later assertion owns its report/u, `${where} retains the actual failing test`);
    assert.match(output, /landing assertion report kept/u);
    assert.match(output, /expected: 1/u);
    assert.match(output, /actual: 2/u);
    assert.match(output, /02-failure\.test\.js:\d+:\d+/u);
    assert.match(output, /(?:^|\n)\s*# fail 1(?:\n|$)/u, `${where} counts the assertion exactly once`);
    assert.equal(output.match(/not ok \d+ - later assertion owns its report/gu)?.length, 1,
      `${where} never duplicates an already reported assertion`);
  }
});
