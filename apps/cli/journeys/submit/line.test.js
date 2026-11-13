/** Public submit preserves both deferred proof and mechanical import notices in one durable line [V4,L3,C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Run the actual private CLI and retain its complete refusal when an assertion fails. */
function json(box, cwd, ...args) {
  const result = box.run(cwd, ...args, '--json');
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Commit only fixture-owned bytes through the installed native Git hooks. */
function commit(box, cwd, message) {
  box.git(cwd, 'add', '-A');
  box.git(cwd, 'commit', '-q', '-m', message);
}

test('clause 1: deferred suite and cross-lane mechanical edit submit both notices on one line [V4,L3,C7]', () => {
  const box = helpers.project('node --test', helpers.sandbox(), { withWorktree: false });
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.submitGate = 'landing';
  config.affectedTests = 'node --test';
  config.lanes.web.owns.push('test/');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  for (const dir of ['web', 'api', 'test']) mkdirSync(join(box.repo, dir), { recursive: true });
  writeFileSync(join(box.repo, 'web/old.js'), 'export const value = 1;\n');
  writeFileSync(join(box.repo, 'api/consumer.js'), "import { value } from '../web/old.js';\nexport const result = value;\n");
  writeFileSync(join(box.repo, 'test/import.test.js'), "import assert from 'node:assert/strict';\nimport { result } from '../api/consumer.js';\nassert.equal(result, 1);\n");
  commit(box, box.repo, 'chore: seed deferred mechanical fixture [G1]');
  const builder = join(box.dir, 'web-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', builder, 'main');
  json(box, builder, 'join', 'web');
  const item = json(box, box.repo, 'add', 'web', 'Repoint the consumer import', '--specs', 'G1', '--check', 'node --test test/import.test.js',
    '--criterion', '1. The consumer imports the renamed module and test/import.test.js passes [test].').item.item_id;
  json(box, builder, 'claim', String(item));
  box.git(builder, 'mv', 'web/old.js', 'web/new.js');
  writeFileSync(join(builder, 'api/consumer.js'), "import { value } from '../web/new.js';\nexport const result = value;\n");
  commit(box, builder, 'refactor(web): repoint consumer import [G1]');
  json(box, builder, 'fact', String(item), 'note', 'clause 1 [test]: test/import.test.js proves clause 1: the consumer import resolves to the renamed module');
  const submitted = json(box, builder, 'submit', String(item), '--no-next');
  assert.equal(submitted.gate.deferred, true);
  assert.match(submitted.gate.report, /cross-lane mechanical edits: api\/consumer\.js/u);
  const shown = json(box, builder, 'show', String(item));
  assert.equal(shown.item_status, 'submitted');
  const event = shown.thread.findLast(row => row.kind === 'submit');
  assert.equal(event.detail.note, 'full suite deferred to the landing gate; cross-lane mechanical edits: api/consumer.js');
  assert.doesNotMatch(event.detail.note, /[\r\n\u2028\u2029]/u);
});
