/** Review eligibility is one computed function: a --review-family item refuses another family unless relaxed with a witness, and authors, shared parents and the builder family are refused through it [C7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Refused } from '../../../../kernel/light.js';
import { eligibilityProblem } from '../../../src/logic/review/eligibility.js';
import { requiredFamilyStands } from '../../../src/logic/review/eligibility.js';
import { reviewEligibilitySummary } from '../../../src/logic/review/eligibility-summary.js';

const WITNESS = { version: 1, threshold: 2, queueLength: 2, waiting: [1, 2], activeSeats: [], at: '2026-01-01T00:16:00.000Z' };
const ITEM = { item_id: 1 };
const REFUSAL = new Refused('REQUIRED_REVIEW_FAMILY', '#1 requires reviewer family anthropic');

test('verify.logic-review-eligibility.relaxed-family-witness: clause 1: with review.relaxRequiredFamily on and a relaxation witness for the item, the required-family refusal does not stand for a seat of another session [C7]', () => {
  const seen = [];
  const witness = (board, item, agentId) => { seen.push([item.item_id, agentId]); return WITNESS; };
  assert.equal(requiredFamilyStands(REFUSAL, {}, ITEM, 'core-2', { relaxRequiredFamily: true, requiredFamilyWitness: witness }), null);
  assert.deepEqual(seen, [[1, 'core-2']]);
});

test('verify.logic-review-eligibility.required-family-refused: clause 2: without a witness, or with the setting off, the required-family refusal stands as today [C7]', () => {
  assert.equal(requiredFamilyStands(REFUSAL, {}, ITEM, 'core-2'), REFUSAL);
  assert.equal(requiredFamilyStands(REFUSAL, {}, ITEM, 'core-2', { relaxRequiredFamily: true, requiredFamilyWitness: () => null }), REFUSAL);
  assert.equal(requiredFamilyStands(REFUSAL, {}, ITEM, 'core-2', { relaxRequiredFamily: false, requiredFamilyWitness: () => WITNESS }), REFUSAL);
  assert.equal(requiredFamilyStands(null, {}, ITEM, 'core-2', { relaxRequiredFamily: true, requiredFamilyWitness: () => WITNESS }), null);
});

test('verify.logic-review-eligibility.show-summary-parity: clause 1: summary preserves ready, strict-only, historical tier, and strict owner output before candidate guards [C7]', () => {
  const strictNotReady = reviewEligibilitySummary({ tier: 'strict', requiredFamily: 'anthropic', ready: false, strictOnly: true,
    strictOwnerFallback: { owner: 'core-1', family: 'openai' } });
  assert.deepEqual(strictNotReady, { summary: { tier: 'strict', requiredFamily: 'anthropic', ready: false,
    eligible: [], ineligible: [], owner: 'core-1' }, candidatesReady: false });
  assert.equal(reviewEligibilitySummary({ tier: 'standard', requiredFamily: null, ready: true, strictOnly: true }).candidatesReady, false);
  assert.deepEqual(reviewEligibilitySummary({ tier: 'legacy', requiredFamily: null, ready: true }).summary,
    { tier: 'legacy', requiredFamily: null, ready: true, eligible: [], ineligible: [] });
});

/**
 * A native in-memory board with one submitted item built by core-1 (openai, parent a). core-2 (anthropic, parent b) is independent,
 * core-3 (anthropic) shares core-1's parent, core-4 (anthropic, parent d) authored a companion patch and core-5 (openai, parent e) shares only the family.
 * The board is an in-memory node:sqlite database holding only the rows the review guards read, so the cases need no store move.
 */
function submitted(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL);
    CREATE TABLE agent (agent_id TEXT PRIMARY KEY, agent_lane TEXT NOT NULL, agent_path TEXT NOT NULL UNIQUE, agent_route TEXT NOT NULL DEFAULT 'strong', agent_family TEXT, agent_created_at TEXT NOT NULL);
    CREATE TABLE item (item_id INTEGER PRIMARY KEY, item_lane TEXT NOT NULL, item_title TEXT NOT NULL, item_status TEXT NOT NULL, item_route TEXT NOT NULL DEFAULT 'strong', item_owner TEXT, item_built_by TEXT, item_builder_family TEXT, item_commit TEXT, item_merged_commit TEXT, item_review_by TEXT, item_review_until TEXT, item_files TEXT NOT NULL DEFAULT '');
    CREATE TABLE event (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}')`);
  const board = { db, clock: { now: () => new Date('2026-01-01T00:00:00.000Z') } };
  const at = '2026-01-01T00:00:00.000Z';
  const seats = [['core-1', 'openai', 'a'], ['core-2', 'anthropic', 'b'], ['core-3', 'anthropic', 'a'], ['core-4', 'anthropic', 'd'], ['core-5', 'openai', 'e']];
  for (const [id, family, parent] of seats) {
    board.db.prepare('INSERT INTO agent (agent_id,agent_lane,agent_path,agent_family,agent_created_at) VALUES (?,?,?,?,?)').run(id, 'core', `/fixture/${id}`, family, at);
    board.db.prepare('INSERT INTO board_meta (meta_key,meta_value) VALUES (?,?)').run(`agent_parent_session:${id}`, parent.repeat(64));
  }
  board.db.prepare(`INSERT INTO item (item_id,item_lane,item_title,item_status,item_built_by,item_builder_family,item_commit)
    VALUES (1,'core','Eligibility fixture','submitted','core-1','openai',?)`).run('a'.repeat(40));
  const patch = { key: 'companion', active: true, patch: 'diff --git a/x.txt b/x.txt\n', commit: 'a'.repeat(40), author: { agentId: 'core-4', parentSession: 'd'.repeat(64), session: '4'.repeat(64) } };
  board.db.prepare('INSERT INTO board_meta (meta_key,meta_value) VALUES (?,?)').run('item_patches:1', JSON.stringify({ version: 1, patches: [patch] }));
  /** The one review decision for a seat, read from the agent table the way the eligibility listing reads it. */
  return (agentId, options) => eligibilityProblem(board, board.db.prepare('SELECT * FROM item WHERE item_id=1').get(),
    board.db.prepare('SELECT agent_id,agent_route FROM agent WHERE agent_id=?').get(agentId), options);
}

test('verify.logic-review-eligibility.builder-refused: eligibilityProblem refuses the builder and a patch author with SELF_VERIFY, and a seat sharing a parent session with an author with SELF_SESSION_VERIFY [C7]', t => {
  const problem = submitted(t);
  assert.equal(problem('core-1')?.code, 'SELF_VERIFY', 'the builder never reviews its own item');
  assert.equal(problem('core-4')?.code, 'SELF_VERIFY', 'the author of a patch on the item never reviews it');
  assert.equal(problem('core-3')?.code, 'SELF_SESSION_VERIFY', 'a seat under the builder parent session is refused');
  assert.equal(problem('core-2'), null, 'an independent seat under another parent is eligible');
});

test('verify.logic-review-eligibility.same-family-refused: with familyPolicy require, eligibilityProblem refuses a reviewer of the builder family with SAME_FAMILY and passes one of another family [C7]', t => {
  const problem = submitted(t);
  const required = { policy: 'any', familyPolicy: 'require' };
  assert.equal(problem('core-5', required)?.code, 'SAME_FAMILY', 'an openai seat may not review an openai build');
  assert.equal(problem('core-2', required), null, 'an anthropic seat under another parent may review it');
  assert.equal(problem('core-5', { policy: 'any', familyPolicy: 'off' }), null, 'with the family policy off the same family passes');
});
