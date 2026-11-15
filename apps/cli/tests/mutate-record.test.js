/** The mutation score per test kind is stored on the item and shown by pullboard show; report only, nothing gates on it [C7,#8056]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { mutationScoreLines } from '../src/logic/mutate/score.js';
import { score } from '../src/logic/mutate/score.js';
import { scoreText } from '../src/logic/mutate/score.js';
import { testKind } from '../src/logic/mutate/score.js';
import { createE2eHelpers } from './fixtures/e2e.js';
import { fileFixtureItem } from './fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

const CALC = 'export function add(a, b) {\n  return a + b;\n}\nexport function isAdult(age) {\n  return age >= 18;\n}\n';
const UNIT = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add, isAdult } from './calc.js';\ntest('add', () => { assert.equal(add(2, 3), 5); });\ntest('adult', () => { assert.equal(isAdult(30), true); assert.equal(isAdult(3), false); });\n";
const CONTRACT = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from './calc.js';\ntest('add contract', () => { assert.equal(add(2, 3), 5); });\n";

test('clause 1: testKind sorts a test path into journey, contract, harness or cell unit [C7]', () => {
  assert.equal(testKind('journeys/ship/main.test.js'), 'journey');
  assert.equal(testKind('tests/journeys/a.test.js'), 'journey');
  assert.equal(testKind('calc.contract.test.js'), 'contract');
  assert.equal(testKind('harness.test.js'), 'harness');
  assert.equal(testKind('tests/fixture-shape.test.js'), 'harness');
  assert.equal(testKind('calc.test.js'), 'cell unit');
});

test('clause 1: score() groups caught and seeded faults by test kind [C7]', () => {
  const report = {
    tests: [{ file: 'calc.test.js' }, { file: 'calc.contract.test.js' }, { file: 'journeys/a.test.js' }],
    faults: [
      { caughtBy: ['calc.test.js', 'calc.contract.test.js'] },
      { caughtBy: ['calc.test.js'] },
      { caughtBy: [] },
      { caughtBy: ['journeys/a.test.js'] },
    ],
  };
  assert.deepEqual(score(report), [
    { kind: 'cell unit', caught: 2, seeded: 4 },
    { kind: 'contract', caught: 1, seeded: 4 },
    { kind: 'journey', caught: 1, seeded: 4 },
  ]);
  assert.equal(scoreText('cells/calc', score(report)), 'mutation score cells/calc: cell unit 2/4, contract 1/4, journey 1/4');
  assert.deepEqual(score({ tests: [], faults: [] }), []);
});

test('clause 1: show lines come from the latest measurement per cell and ignore other facts [C7]', () => {
  const fact = (kind, text) => ({ type: 'fact', kind, text });
  const lines = mutationScoreLines([
    fact('measurement', 'mutation score cells/calc: cell unit 1/4'),
    fact('measurement', 'p95 was 3 ms'),
    fact('note', 'mutation score cells/other: cell unit 0/1'),
    fact('measurement', 'mutation score cells/calc: cell unit 3/4'),
    { type: 'move', kind: 'claim' },
  ]);
  assert.deepEqual(lines, ['mutation score (report only): cells/calc: cell unit 3/4']);
});

test('clause 1: mutate --item stores the score on the item, show prints it, and a score of 0 never refuses [C7]', async () => {
  const box = helpers.project('true');
  const dir = join(box.repo, 'cells', 'calc');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'calc.js'), CALC);
  writeFileSync(join(dir, 'calc.test.js'), UNIT);
  writeFileSync(join(dir, 'calc.contract.test.js'), CONTRACT);
  const id = String(fileFixtureItem(box, box.repo, { lane: 'web', title: 'Scored', criterion: 'a scored fixture item' }).item_id);
  const ran = await box.inProcess(box.repo, 'mutate', 'cells/calc', '--all', '--item', id);
  assert.equal(ran.code, 0, ran.out + ran.err);
  assert.match(ran.out, /score {2}cell unit {2}caught \d+ of \d+/u);
  assert.match(ran.out, /score {2}contract {2}caught \d+ of \d+/u);
  const shown = await box.inProcess(box.repo, 'show', id);
  assert.equal(shown.code, 0, shown.out + shown.err);
  assert.match(shown.out, /^mutation score \(report only\): cells\/calc: cell unit \d+\/\d+, contract \d+\/\d+$/mu);
  const json = JSON.parse((await box.inProcess(box.repo, 'show', id, '--json')).out);
  assert.ok(json.thread.some((entry) => entry.kind === 'measurement' && /^mutation score cells\/calc: /u.test(entry.text)));
  const none = await box.inProcess(box.repo, 'mutate', 'cells/calc', '--all');
  assert.equal(none.code, 0, 'without --item nothing is recorded and nothing refuses');
});

test('clause 1: no refusal reads a mutation score, so a score of 0 cannot block submit, verify or landing [C7]', () => {
  const readers = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'tests' && entry.name !== 'journeys') walk(full); } else if (/\.m?js$/u.test(entry.name) && /mutation score/u.test(readFileSync(full, 'utf8'))) readers.push(full);
    }
  };
  const here = new URL('../../..', import.meta.url).pathname;
  walk(join(here, 'apps', 'cli', 'src'));
  walk(join(here, 'packages'));
  const names = readers.map((file) => file.slice(here.length));
  assert.deepEqual(names.filter((name) => !/(?:logic\/mutate\/score|commands\/mutate|commands\/show|io\/mutate\/journey-check|logic\/test\/journey-check|io\/test\/journey-check)\.js$/u.test(name)), [], 'only the score, mutate, show and journey-check files mention it (journey-check reports and retags tags, it refuses nothing, since 2a4a65f1b7)');
  for (const name of names) assert.doesNotMatch(readFileSync(join(here, name), 'utf8'), /new Refused\([^)]*mutation score/u, `${name} refuses on a score`);
});
