/** Real acceptance, landing and conflict rework through the native engine [B35,B3,R3]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { onBoard } from './land-board-fixture.js';
import * as store from '../packages/store/index.js';
import { landAcceptedItems } from '../packages/merge/index.js';
import { automaticLandingEnabled } from '../packages/merge/index.js';
import { requireManualLanding } from '../packages/merge/index.js';
import { configFromSource } from '../packages/config/index.js';

/** Require an actual successful JSON command. */
function json(box, root, ...args) {
  const result = box.run(root, ...args, '--json');
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

/** Commit fixture source through the installed ordinary hooks. */
function commit(box, root, message) {
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', message);
  return box.git(root, 'rev-parse', 'HEAD');
}

/** Submit from a builder and accept from an independent reviewer while trunk stays on main. */
function fixture(t, manualOverride = false, redStatic = false) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const config = { ...helpers.CONFIG, gate: 'true', landing: { publish: 'separate', manualOverride } };
  if (redStatic) {
    config.staticChecks = 'node static.cjs';
    writeFileSync(join(box.repo, 'static.cjs'), `if (require('node:fs').existsSync(${JSON.stringify(join(box.dir, 'red-static'))})) { console.log('automatic static guard is red'); process.exit(1); }\n`);
  }
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/result.txt'), 'base\n');
  commit(box, box.repo, 'chore: configure automatic landing');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const id = json(box, box.repo, 'add', 'web', 'Build result', '--specs', 'G1', '--criterion', 'the result exists', '--check', 'test -f web/result.txt').item.item_id;
  json(box, box.web, 'claim', String(id));
  writeFileSync(join(box.web, 'web/result.txt'), 'built\n');
  const head = commit(box, box.web, 'feat(web): build the result [G1]');
  json(box, box.web, 'submit', String(id));
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
  json(box, reviewer, 'join', 'api');
  return { box, config, id, head, reviewer };
}

test('acceptance lands a clean head without a coordinator command; manual land requires the override [B35,B3,R3]', t => {
  const { box, id, head, reviewer } = fixture(t);
  const refused = box.run(box.repo, 'land');
  assert.equal(refused.code, 1);
  assert.match(refused.out + refused.err, /the board lands accepted items/u);
  json(box, reviewer, 'verify', String(id), 'accept', '--note', 'Read the result and ran its frozen check.');
  const item = json(box, box.repo, 'show', String(id));
  assert.ok(item.item_merged_commit, 'acceptance records the landing commit itself');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), item.item_merged_commit);
  assert.equal(readFileSync(join(box.repo, 'web/result.txt'), 'utf8'), 'built\n');
  box.git(box.repo, 'merge-base', '--is-ancestor', head, item.item_merged_commit);
});

test('automatic landing returns a conflicting acceptance to its builder with exact files [B35,B3,R3]', async t => {
  const { box, config, id, head, reviewer } = fixture(t, true);
  json(box, reviewer, 'verify', String(id), 'accept', '--note', 'Read the result and ran its frozen check.');
  writeFileSync(join(box.repo, 'web/result.txt'), 'changed trunk\n');
  config.landing.manualOverride = false;
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  const trunk = commit(box, box.repo, 'chore: change trunk before automatic landing');
  const returned = [];
  let batches = 0;
  await landAcceptedItems({ root: box.repo, config, trunk, items: [{ id, commit: head }],
    reopen: (item, conflict) => {
      returned.push(conflict);
      return onBoard(box, board => store.reopen(board, item, { agentId: 'coordinator', conflict, note: `landing conflict: ${conflict.files.join(', ')}` }));
    },
    execute: () => { batches++; } });
  assert.equal(batches, 1, 'the remaining clean batch is selected once');
  assert.deepEqual(returned, [{ files: ['web/result.txt'], trunk }]);
  assert.equal(json(box, box.repo, 'show', String(id)).item_status, 'open');
  assert.equal(json(box, box.web, 'claim', String(id)).item_owner, 'web-1');
});

test('only an explicit valid trunk override permits manual landing [B35,B3]', () => {
  assert.equal(automaticLandingEnabled(configFromSource('{}')), true);
  assert.throws(() => requireManualLanding(configFromSource('{}')), /the board lands accepted items/u);
  assert.doesNotThrow(() => requireManualLanding(configFromSource('{"landing":{"manualOverride":true}}')));
  assert.throws(() => configFromSource('{"landing":{"manualOverride":"yes"}}'), /BAD_CONFIG/u);
  assert.equal(configFromSource('{"landing":{"manualOverride":true}}').landing.manualOverride, true);
});


test('a red automatic landing returns its accepted item with gate output [B35,B3,R3]', t => {
  const { box, id, reviewer } = fixture(t, false, true);
  writeFileSync(join(box.dir, 'red-static'), 'red\n');
  const accepted = box.run(reviewer, 'verify', String(id), 'accept', '--note', 'The frozen file check passed.');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  const item = json(box, box.repo, 'show', String(id));
  assert.equal(item.item_status, 'open', accepted.out + accepted.err);
  assert.equal(item.item_merged_commit, null);
  const reopens = onBoard(box, board => store.events(board, { itemId: id }).filter(event => event.event_kind === 'reopen'));
  assert.equal(reopens.length, 1, 'one red landing returns the item once');
  assert.match(reopens[0].event_detail, /automatic static guard is red/u);
});
