/** The cockpit machine box writes one parity record per CLI call in both modes, only when asked [C7,U149]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import {
  machine,
  project,
} from './machine.js';
import { fixtureSettledMachine } from '../testkit.js';
import { runTwice } from './machine-twin.js';

const records = privateFixtureFiles('machine-parity-').root;
after(() => rmSync(records, { recursive: true, force: true }));

test('clause 1: with PULLBOARD_PARITY_RECORD set, box.run and box.inProcess append one record each with the same exit code and board state [C7,U149]', async () => {
  const box = machine();
  const { repo } = project(box, 'demo');
  const file = join(records, 'on.jsonl');
  process.env.PULLBOARD_PARITY_RECORD = file;
  try {
    await runTwice(box, repo, ['status']);
  } finally { delete process.env.PULLBOARD_PARITY_RECORD; }
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].args, ['status']);
  assert.equal(lines[0].code, lines[1].code);
  assert.deepEqual(lines[0].board, lines[1].board);
});

test('clause 2: nothing is written when PULLBOARD_PARITY_RECORD is unset [C7,U149]', async () => {
  const box = machine();
  const { repo } = project(box, 'demo');
  const file = join(records, 'off.jsonl');
  delete process.env.PULLBOARD_PARITY_RECORD;
  await runTwice(box, repo, ['status']);
  assert.equal(existsSync(file), false);
});

test('clause 3: box.tryGit answers a result whose status reads without await, with test.inProcessHooks on [C7,#12659]', () => {
  const box = machine();
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { test: { inProcessHooks: true } });
  const { repo } = project(box, 'demo');
  const answer = box.tryGit(repo, 'rev-parse', '--git-dir');
  assert.ok(!(answer instanceof Promise), 'a plain tryGit is not a promise');
  assert.equal(answer.status, 0);
});
