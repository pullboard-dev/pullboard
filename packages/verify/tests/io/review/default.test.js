import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REVIEW_DEFAULT_ENGINE } from '../../../../state/light.js';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellReviewAccept } from '../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { submitFixture } from '../../../../store/tests/fixtures/submit.js';
import { withdraw } from '../../../../store/index.js';
import { normalizeReviewDefaults } from '../../../src/io/review/default.js';
import { itemReviewPolicy } from '../../../src/logic/review/policy.js';

const NOW = '2026-01-01T00:00:00.000Z';
const JUDGMENT_FILE = 'packages/verify/src/logic/review/policy.js';

/** Seed one judgment item whose row can be compared before and after the bounded write. */
function addJudgmentItem(board, title) {
  const { item_id: id } = cellItem(board, { lane: 'core', title, criterion: 'prove the written item' });
  board.db.prepare('UPDATE item SET item_files=? WHERE item_id=?').run(JUDGMENT_FILE, id);
  return id;
}

/** Observe every item-table read while keeping statements attached to their real SQLite connection. */
function watchItemReads(board) {
  const db = board.db;
  const reads = [];
  let allowedId;
  board.db = new Proxy(db, { get(target, property) {
    if (property !== 'prepare') return Reflect.get(target, property, target)?.bind?.(target) ?? Reflect.get(target, property, target);
    return sql => {
      const statement = target.prepare(sql);
      return new Proxy(statement, { get(prepared, method) {
        const value = Reflect.get(prepared, method, prepared);
        if (!['get', 'all', 'run'].includes(method) || typeof value !== 'function') return value;
        return (...args) => {
          if (/\bFROM\s+item\b/iu.test(sql)) reads.push({ sql, args, allowedId });
          return value.apply(prepared, args);
        };
      } });
    };
  } });
  return { reads, rawDb: db, allow: id => { allowedId = id; } };
}

test('verify.io-review-default.written-item: clause 1: the written-item default normalization binds one id and preserves its projected policy, witness, event and notice [C7]', (t) => {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, { now: () => new Date(NOW) }, { real: true, gitRoot: project.repo });
  const target = addJudgmentItem(board, 'written target');
  const sensitive = addJudgmentItem(board, 'explicit sensitive');
  const family = addJudgmentItem(board, 'review family');
  const strict = addJudgmentItem(board, 'explicit strict tier');
  const verified = addJudgmentItem(board, 'finished verified');
  const withdrawn = addJudgmentItem(board, 'finished withdrawn');
  const builder = cellSeat(board, { lane: 'core', path: '/fixture/default-builder', family: 'openai' });
  const reviewer = cellSeat(board, { lane: 'core', path: '/fixture/default-reviewer', family: 'openai' });
  cellClaim(board, verified, builder, { root: project.repo });
  submitFixture(board, verified, { agentId: builder.id, commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
  cellReviewAccept(board, verified, reviewer);
  withdraw(board, withdrawn, { agentId: 'coordinator', reason: 'fixture withdrawal' });
  const unrelated = Array.from({ length: 24 }, (_, index) => addJudgmentItem(board, `unrelated ${index}`));
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)').run(`review_independence:${sensitive}`, JSON.stringify({ version: 1, sensitive: true, reviewFamily: null }));
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)').run(`item_review_family:${family}`, 'anthropic');
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)').run(`review_independence:${strict}`, JSON.stringify({ version: 1, sensitive: false, reviewFamily: null, reviewTier: 'strict' }));

  const before = board.db.prepare('SELECT item_id,item_status,item_files FROM item ORDER BY item_id').all();
  const { reads, rawDb, allow } = watchItemReads(board);
  const events = [];
  const logEvent = (_board, ...args) => events.push(args);
  allow(target);
  normalizeReviewDefaults(board, { itemId: target, logEvent });
  const witness = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`review_default:normalized:${target}`);
  assert.deepEqual(JSON.parse(witness.meta_value), { item: target, at: NOW, from: 'strict', to: 'standard', reason: 'no explicit sensitive or review-family mark' });
  assert.equal(board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='review_default:active'").get().meta_value, String(REVIEW_DEFAULT_ENGINE));
  assert.deepEqual(events, [['board', 'review-default', null, { engine: REVIEW_DEFAULT_ENGINE, count: 1, unfinished: [target] }]]);
  assert.deepEqual(board.reviewDefaultNotice, ['1 items moved to standard review.', `#${target} review normalized from strict to standard: no explicit sensitive or review-family mark.`]);
  const notice = board.reviewDefaultNotice;
  allow(target);
  normalizeReviewDefaults(board, { itemId: target, logEvent });
  assert.equal(events.length, 1, 'a repeated write does not add another witness event');
  assert.deepEqual(board.reviewDefaultNotice, notice);

  for (const id of [sensitive, family, strict, verified, withdrawn, ...unrelated]) {
    allow(id);
    const beforeEvents = events.length;
    normalizeReviewDefaults(board, { itemId: id, logEvent });
    if ([sensitive, family, strict].includes(id)) {
      assert.equal(events.length, beforeEvents, `explicit policy mark on ${id} stays strict without a normalization event`);
      assert.equal(board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(`review_default:normalized:${id}`), undefined);
      assert.equal(itemReviewPolicy(board, id).tier, 'strict');
      continue;
    }
    const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`review_default:normalized:${id}`);
    assert.ok(row, `implicit judgment item ${id} receives its witness`);
    assert.deepEqual(events.at(-1), ['board', 'review-default', null, { engine: REVIEW_DEFAULT_ENGINE, count: 1,
      unfinished: ['verified', 'withdrawn'].includes(before.find(item => item.item_id === id)?.item_status) ? [] : [id] }]);
    assert.deepEqual(board.reviewDefaultNotice, ['1 items moved to standard review.',
      ...(['verified', 'withdrawn'].includes(before.find(item => item.item_id === id)?.item_status) ? [] : [`#${id} review normalized from strict to standard: no explicit sensitive or review-family mark.`])]);
    assert.equal(itemReviewPolicy(board, id).tier, 'standard', 'the normalized policy is projected as standard after the global activation witness');
  }
  assert.deepEqual(rawDb.prepare('SELECT item_id,item_status,item_files FROM item ORDER BY item_id').all(), before, 'all item rows, including unrelated rows, remain unchanged');
  assert.ok(reads.length > 0);
  assert.ok(reads.every(({ sql, args, allowedId }) => /\bWHERE\s+item_id\s*=\s*\?/iu.test(sql) && args.length === 1 && args[0] === allowedId), 'every item-table read binds only the written item id');

  const historicalBoard = cellBoard(t, project.boardFile.replace('board.sqlite', 'historical.sqlite'), { now: () => new Date(NOW) }, { real: true, gitRoot: project.repo });
  const old = addJudgmentItem(historicalBoard, 'old engine item');
  historicalBoard.executionEngineVersion = REVIEW_DEFAULT_ENGINE - 1;
  normalizeReviewDefaults(historicalBoard, { itemId: old, logEvent });
  assert.equal(historicalBoard.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(`review_default:normalized:${old}`), undefined);
  assert.equal(historicalBoard.db.prepare("SELECT 1 FROM board_meta WHERE meta_key='review_default:active'").get(), undefined);

  const emptyBoard = cellBoard(t, project.boardFile.replace('board.sqlite', 'empty.sqlite'), { now: () => new Date(NOW) }, { real: true, gitRoot: project.repo });
  normalizeReviewDefaults(emptyBoard, { itemId: 999999, logEvent });
  assert.equal(emptyBoard.db.prepare("SELECT 1 FROM board_meta WHERE meta_key='review_default:active'").get(), undefined);

  const missingMeta = cellBoard(t, project.boardFile.replace('board.sqlite', 'missing-meta.sqlite'), { now: () => new Date(NOW) }, { real: true, gitRoot: project.repo });
  missingMeta.db.exec('DROP TABLE board_meta');
  normalizeReviewDefaults(missingMeta, { itemId: target, logEvent });
  const missingItem = cellBoard(t, project.boardFile.replace('board.sqlite', 'missing-item.sqlite'), { now: () => new Date(NOW) }, { real: true, gitRoot: project.repo });
  missingItem.db.exec('PRAGMA foreign_keys=OFF; DROP TABLE item');
  normalizeReviewDefaults(missingItem, { itemId: target, logEvent });

  const rollbackBoard = cellBoard(t, project.boardFile.replace('board.sqlite', 'rollback.sqlite'), { now: () => new Date(NOW) }, { real: true, gitRoot: project.repo });
  const rollbackId = addJudgmentItem(rollbackBoard, 'failed write rollback');
  rollbackBoard.db.exec("CREATE TRIGGER refuse_review_default_active BEFORE INSERT ON board_meta WHEN NEW.meta_key='review_default:active' BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END; BEGIN");
  assert.throws(() => normalizeReviewDefaults(rollbackBoard, { itemId: rollbackId, logEvent }));
  rollbackBoard.db.exec('ROLLBACK; DROP TRIGGER refuse_review_default_active');
  assert.equal(rollbackBoard.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(`review_default:normalized:${rollbackId}`), undefined, 'the caller transaction rolls the witness back with a failed activation write');
});
