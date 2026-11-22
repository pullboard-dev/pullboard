/** @pullboard-test-input apps/cli/tests/fixtures apps/cli/tests/fixtures/registry*.json */
/** @pullboard-world-pin the registry case checks this shipped test source and its actual item shard for complete unique proof records. */
/** Real list dispatch preserves JSON, text, default settings and filters while JSON skips text-only SQLite reads [C7,#12932]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { registryFindings } from '../../../../../../packages/verify/index.js';
import { logEvent } from '../../../../../../packages/store/index.js';
import { withFixtureBoard } from '../../../fixtures/board.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { recordListReads } from '../../../fixtures/list-reads.js';
import { fixtureAdd } from '../../../fixtures/testkit.js';
import { pinDerivedStateOff } from '../../../fixtures/thin-door.js';
import { thinListRows } from '../../../../src/io/list/thin.js';

test('cli.io-list-thin-text.json-skips-text-metadata: actual JSON list skips metadata reads while text and default modes preserve rendered names, merge labels and filtered output [C7]', async (t) => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project();
  t.after(pinDerivedStateOff(box));
  for (const [lane, title] of [['web', 'Claimed item'], ['web', 'Conflicting item'], ['api', 'Other lane item']]) {
    const added = await fixtureAdd(box.runLocal, box.repo, lane, title);
    assert.equal(added.code, 0, added.err);
  }
  const claimed = await box.runLocal(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  // A private fixture event supplies a genuine text-only merge label without changing any item row.
  withFixtureBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), board => {
    logEvent(board, 'coordinator', 'reopen', 2, { conflict: { files: ['web/conflict.js'], trunk: 'a'.repeat(40) }, commit: 'b'.repeat(40) });
  });
  const settingsFile = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  /** Pin or omit list.thinRead, keeping the same fixture and all other settings. */
  const mode = value => {
    const next = { ...settings };
    if (value === undefined) delete next.list; else next.list = { thinRead: value };
    writeFileSync(settingsFile, JSON.stringify(next));
  };
  /** Capture real command output plus the actual SQLite metadata reads it performed. */
  const listed = async args => {
    const answer = await recordListReads(() => box.runLocal(box.repo, 'list', ...args));
    assert.equal(answer.result.code, 0, answer.result.err);
    return answer;
  };
  mode(false);
  const complete = JSON.parse((await listed(['--json'])).result.out);
  const route = complete.items[0].item_route;
  for (const args of [[], ['web'], ['api'], ['--all'], ['--route', route]]) {
    mode(false);
    const expectedJson = await listed([...args, '--json']);
    const expectedText = await listed(args);
    for (const setting of [true, undefined]) {
      mode(setting);
      const json = await listed([...args, '--json']);
      assert.deepEqual(JSON.parse(json.result.out), JSON.parse(expectedJson.result.out));
      assert.deepEqual(json.reads, { merges: 0, agents: 0 });
      const text = await listed(args);
      assert.equal(text.result.out, expectedText.result.out);
      assert.ok(text.reads.merges > 0, 'text still reads merge labels');
      assert.ok(text.reads.agents > 0, 'text still reads display names');
    }
  }
  mode(undefined);
  const rendered = (await listed([])).result.out;
  assert.match(rendered, /claimed web-1 \([^)]+\)/u);
  assert.doesNotMatch(rendered, /web-1 \(unknown\)/u);
  assert.match(rendered, /\(needs main merge\).*Conflicting item/u);
  const direct = await thinListRows({ cwd: box.repo });
  const json = await thinListRows({ cwd: box.repo, text: false });
  assert.ok(direct.agents.length > 0, 'direct callers retain metadata by default');
  assert.deepEqual([...direct.merging], [2]);
  assert.deepEqual(json.items, direct.items);
  assert.deepEqual(json.needsRescope, direct.needsRescope);
  assert.deepEqual(json.agents, []);
  assert.deepEqual([...json.merging], []);
});

test('cli.io-list-thin-text.registry: release behavior tests have complete unique registry records in the item shard [C7]', () => {
  const fixtures = join(import.meta.dirname, '../../../fixtures');
  const records = JSON.parse(readFileSync(join(fixtures, 'registry-12932.json'), 'utf8'));
  const source = readFileSync(import.meta.filename, 'utf8');
  const result = registryFindings([{ file: 'apps/cli/tests/io/list/thin/text.test.js', source }], records);
  assert.deepEqual(result.findings, []);
  for (const id of result.ids) {
    const owners = readdirSync(fixtures).filter(name => /^registry(?:-[^.]+)?\.json$/u.test(name))
      .filter(name => Object.hasOwn(JSON.parse(readFileSync(join(fixtures, name), 'utf8')), id));
    assert.deepEqual(owners, ['registry-12932.json']);
    assert.deepEqual(records[id].proves.specs, ['C7']);
    assert.ok(records[id].why.length > 0);
    assert.equal(records[id].kind, 'cell unit');
    assert.deepEqual(records[id].inputs, ['apps/cli/tests/io/list/thin/text.test.js']);
  }
});
