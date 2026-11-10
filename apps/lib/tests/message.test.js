/** The shared commit-message builder and parser: ids fill what fits, then +N, with every row in a trailer (RFC 0005) [C7,B3,R3]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { headerRows } from '../../../packages/spec/index.js';
import {
  HEADER_LIMIT,
  buildCommitMessage,
  commitMessageProblems,
  parseCommitMessage,
  specOrder,
} from '../../../packages/commits/index.js';
import { landingRows } from '../../../packages/commits/index.js';
import { checkLandingMessages } from '../../../packages/landing/index.js';
import { itemCommitType } from '../../../packages/landing/index.js';
import { landingMessage } from '../../../packages/landing/index.js';
import { citedIds } from '../../../packages/spec/index.js';
import { parseSpec } from '../../../packages/spec/index.js';
import { defaults } from '../../../packages/config/index.js';
import { commitMsgProblems } from '../../../packages/commits/index.js';
import { cellSandbox } from '../../../packages/store/tests/fixtures/cell.js';

const cleanups = [];
after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });
/** The module-level owner of each sandbox's cleanup, for helpers that run outside a test context. */
const owner = { after: cleanup => cleanups.push(cleanup) };

/** Row ids A1..An, the shape a long cited set takes. */
const rowsUpTo = (count, letter = 'A') => Array.from({ length: count }, (_, index) => `${letter}${index + 1}`);

/** Parse a built message and build it again from the parse: both directions must be exact. */
function roundTrip(input) {
  const built = buildCommitMessage(input);
  const parsed = parseCommitMessage(built.message);
  assert.equal(parsed.header, built.header);
  assert.equal(parsed.type, input.type);
  assert.equal(parsed.scope, input.scope);
  assert.equal(parsed.item, input.item);
  assert.deepEqual(parsed.rows, input.rows.length ? input.rows : null, 'Pullboard-Rows carries every row, or is absent');
  assert.deepEqual(parsed.shown, input.rows.slice(0, parsed.shown.length), 'the header shows the first rows');
  assert.equal(parsed.shown.length + parsed.more, input.rows.length, '+N counts exactly the rows the header leaves out');
  const again = buildCommitMessage({ type: parsed.type, scope: parsed.scope, title: parsed.title, item: parsed.item, rows: parsed.rows ?? [] });
  assert.equal(again.message, built.message, 'building from the parse writes the same bytes');
  assert.deepEqual(commitMessageProblems(built.message, { item: input.item, rows: input.rows }), []);
  assert.ok(built.header.length <= HEADER_LIMIT, built.header);
  assert.deepEqual(parsed.trailers.map((entry) => entry.key), ['Pullboard-Item', ...(input.rows.length ? ['Pullboard-Rows'] : [])], 'the trailers come in the fixed order');
  assert.ok(built.message.endsWith(built.trailers), 'the trailers are the last paragraph');
  return { built, parsed };
}

test('one row: the header shows it and the trailers name the item then the row [C7,B3,R3]', () => {
  const { built } = roundTrip({ type: 'feat', scope: 'merge', title: 'Person-only moves are signed', item: 408, rows: ['E22'] });
  assert.equal(built.message, 'feat(merge): person-only moves are signed [E22]\n\nPullboard-Item: #408\nPullboard-Rows: E22');
});

test('many consecutive rows fill the header, then +N stands for the rest [C7,B3,R3]', () => {
  const twelve = roundTrip({ type: 'chore', scope: 'merge', title: 'Land the batch', item: 7, rows: rowsUpTo(12) });
  assert.equal(twelve.built.header, 'chore(merge): land the batch [A1,A2,A3,A4,A5,A6,A7,A8,A9,A10,A11,A12]', 'every row shows when they all fit');
  const twenty = roundTrip({ type: 'chore', scope: 'merge', title: 'Land the batch', item: 7, rows: rowsUpTo(20) });
  assert.equal(twenty.built.header, 'chore(merge): land the batch [A1,A2,A3,A4,A5,A6,A7,A8,A9,A10,A11,A12,+8]');
  assert.equal(twenty.built.header.length, HEADER_LIMIT);
  assert.equal(twenty.parsed.more, 8);
  // The ids fill what fits: one more shown id would cross the limit.
  const longer = `chore(merge): land the batch [${[...rowsUpTo(13), '+7'].join(',')}]`;
  assert.ok(longer.length > HEADER_LIMIT, longer);
});

test('scattered ids land in spec order, doctrine rows after the spec rows [C7,B3,R3]', () => {
  const spec = parseSpec('# Spec\n\n## A\n- A2 [approved, must] Two.\n## C\n- C7 [approved, must] Seven.\n## M\n- M3 [approved, must] Three.\n## Z\n- Z9 [approved, must] Nine.\n');
  const rows = specOrder(['Z9', 'doctrine:PB1', 'A2', 'M3', 'C7', 'A2'], spec);
  assert.deepEqual(rows, ['A2', 'C7', 'M3', 'Z9', 'doctrine:PB1'], 'spec order, duplicates once, doctrine last');
  const { built } = roundTrip({ type: 'chore', scope: 'merge', title: 'Scattered rows land', item: 9, rows });
  assert.equal(built.message, 'chore(merge): scattered rows land [A2,C7,M3,Z9,doctrine:PB1]\n\nPullboard-Item: #9\nPullboard-Rows: A2,C7,M3,Z9,doctrine:PB1');
});

test('36 rows never refuse: the header keeps the title and the trailer keeps all 36 [C7,B3,R3]', () => {
  const rows = rowsUpTo(36);
  const { built, parsed } = roundTrip({ type: 'docs', scope: 'merge', title: 'Update the handbook', item: 1326, rows });
  assert.equal(built.header, 'docs(merge): update the handbook [A1,A2,A3,A4,A5,A6,A7,A8,A9,A10,+26]');
  assert.equal(built.trailers, `Pullboard-Item: #1326\nPullboard-Rows: ${rows.join(',')}`);
  assert.equal(parsed.rows.length, 36);
  // The title keeps priority: a title that needs the whole header still lands, showing the ids that fit after it.
  const long = roundTrip({ type: 'chore', scope: 'merge', title: 'A VERY LONG TITLE '.repeat(10), item: 91, rows });
  assert.equal(long.built.header, 'chore(merge): a very long title a very long title a very long [A1,+35]');
});

test('no rows: no brackets and no Pullboard-Rows trailer [C7,B3,R3]', () => {
  const { built, parsed } = roundTrip({ type: 'test', scope: 'merge', title: 'Every test run an agent starts goes through the runner pool', item: 1219, rows: [] });
  assert.equal(built.message, 'test(merge): every test run an agent starts goes through the runner pool\n\nPullboard-Item: #1219');
  assert.equal(parsed.rows, null);
  assert.deepEqual(parsed.shown, []);
});

test('the parser reads trailers only as the last paragraph and +N is never an id [C7,B3,R3]', () => {
  const parsed = parseCommitMessage('fix(core): read the rows [A1,A2,+3]\n\nWhy it matters.\n\nPullboard-Item: #12\nPullboard-Rows: A1,A2,A3,A4,A5\n');
  assert.deepEqual({ type: parsed.type, scope: parsed.scope, title: parsed.title, shown: parsed.shown, more: parsed.more, body: parsed.body, item: parsed.item, rows: parsed.rows },
    { type: 'fix', scope: 'core', title: 'read the rows', shown: ['A1', 'A2'], more: 3, body: 'Why it matters.', item: 12, rows: ['A1', 'A2', 'A3', 'A4', 'A5'] });
  const trailing = parseCommitMessage('fix(core): read the rows [A1]\n\nPullboard-Item: #12\n\ntext after the trailers');
  assert.equal(trailing.item, null, 'text after the trailers leaves the message with none');
  assert.deepEqual(citedIds('chore(merge): land it [A1,A2,+34]'), ['A1', 'A2']);
  assert.deepEqual(citedIds('chore(merge): land it [+36]'), []);
  assert.deepEqual(citedIds('feat(web): add the page [G1, K1.2]'), ['G1', 'K1.2'], 'a hand-written header still reads');
  assert.deepEqual(headerRows('fix: handle [x] in the middle of text'), { shown: [], more: 0, rest: 'fix: handle [x] in the middle of text' });
  assert.deepEqual(commitMessageProblems('chore(merge): land it [A2,+1]\n\nPullboard-Item: #3\nPullboard-Rows: A1,A2', { item: 3, rows: ['A1', 'A2'] }),
    ['its header ids are not the first rows followed by +N for the rest']);
});

test('a landing names the refrozen rows in spec order, and a batch checks every message before merging [C7,B3,R3]', () => {
  const spec = parseSpec('# Spec\n\n## A\n- A1 [approved, must] One.\n- A2 [approved, must] Two.\n- A3 [approved, must] Three.\n');
  const claimed = { item_id: 5, item_lane: 'core', item_title: 'Refrozen rows', item_spec_ids: 'A3,A1',
    item_frozen: JSON.stringify({ title: 'Refrozen rows', criterion: 'c', rows: [{ id: 'A3' }, { id: 'A1' }] }) };
  assert.deepEqual(landingRows(claimed, spec), ['A1', 'A3']);
  // A refreeze after the claim replaced the frozen set: the landing writes the final frozen rows.
  const refrozen = { ...claimed, item_frozen: JSON.stringify({ title: 'Refrozen rows', criterion: 'c2', rows: [{ id: 'A3' }, { id: 'A2' }, { id: 'A1' }] }) };
  assert.equal(landingMessage(refrozen, { spec }).message, 'chore(merge): refrozen rows [A1,A2,A3]\n\nPullboard-Item: #5\nPullboard-Rows: A1,A2,A3');
  const none = { item_id: 6, item_lane: 'docs', item_title: 'No rows', item_spec_ids: '', item_frozen: JSON.stringify({ rows: [] }) };
  assert.equal(landingMessage(none, { spec }).message, 'docs(merge): no rows\n\nPullboard-Item: #6');
  const many = { item_id: 8, item_lane: 'core', item_title: 'Many rows', item_spec_ids: rowsUpTo(36).join(',') };
  assert.equal(landingMessage(many).rows.length, 36, 'no citation count refuses');
  const checked = checkLandingMessages([refrozen, none, many], { spec });
  assert.deepEqual([...checked.keys()], [5, 6, 8]);
  // A malformed row id (never written by the spec) fails the check for the whole batch, naming the item.
  const broken = { ...many, item_id: 9, item_spec_ids: '', item_frozen: JSON.stringify({ rows: [{ id: 'A1' }, { id: 'A2,A3' }] }) };
  assert.throws(() => checkLandingMessages([refrozen, broken], { spec }), (error) => {
    assert.equal(error.code, 'LAND_HEADER');
    assert.match(error.message, /#9/u);
    assert.doesNotMatch(error.message, /shorten|cut|remove|fewer|cited set/iu, 'no refusal advises removing citations');
    return true;
  });
});

test('one header per item type: the type is the item\'s commits\' first of feat, fix, perf, refactor, revert, docs, test, build, ci, style, chore, with or without rows, else the lane rule [C7,B3,R3]', () => {
  const box = cellSandbox(owner);
  const repo = join(box.dir, 'types');
  box.git(box.dir, 'init', '-q', '-b', 'main', repo);
  /** Commit one file with a header, returning the new head. */
  const commit = (file, header) => {
    writeFileSync(join(repo, file), `${header}\n`);
    box.git(repo, 'add', file);
    box.git(repo, 'commit', '-q', '-m', header);
    return box.git(repo, 'rev-parse', 'HEAD');
  };
  const base = commit('base.txt', 'chore: start the fixture');
  const item = { item_id: 40, item_lane: 'core', item_title: 'Typed landing', item_spec_ids: 'A1' };
  const cases = [
    [['docs(core): explain it [A1]', 'feat(core): add it [A1]', 'fix(core): mend it [A1]'], 'feat'],
    [['test(core): prove it', 'fix(core): mend it [A1]'], 'fix'],
    [['docs(core): explain it'], 'docs'],
    [['test(core): prove it'], 'test'],
    [['refactor(core): tidy it', 'chore(core): sweep it'], 'refactor'],
    [['perf(core): speed it', 'docs(core): explain it'], 'perf'],
    [['chore(core): sweep it'], 'chore'],
    [['an untyped header'], null],
  ];
  for (const [index, [headers, expected]] of cases.entries()) {
    box.git(repo, 'switch', '-q', '--detach', base);
    let head = base;
    for (const [step, header] of headers.entries()) head = commit(`case-${index}-${step}.txt`, header);
    assert.equal(itemCommitType(repo, base, head), expected, headers.join(' | '));
    const built = landingMessage(item, { type: itemCommitType(repo, base, head) });
    assert.equal(built.header, `${expected ?? 'chore'}(merge): typed landing [A1]`, 'each item type writes its own merge header');
    assert.deepEqual(parseCommitMessage(built.message).type, expected ?? 'chore');
  }
  // A rowless item keeps its own type too; only an item with no typed commit takes the lane rule.
  const rules = defaults().commits;
  const spec = parseSpec('');
  for (const type of ['feat', 'fix', 'test']) {
    const rowless = landingMessage({ ...item, item_spec_ids: '', item_lane: 'docs' }, { type });
    assert.equal(rowless.message, `${type}(merge): typed landing\n\nPullboard-Item: #40`);
    assert.deepEqual(commitMsgProblems(rowless.message, { rules, spec, rowlessLandings: [40] }), [], `a landing checkout accepts a rowless ${type} landing`);
    if (type !== 'test') {
      assert.notDeepEqual(commitMsgProblems(rowless.message, { rules, spec }), [], `outside a landing the ${type} trailer exempts nothing`);
      assert.notDeepEqual(commitMsgProblems(rowless.message.replace('#40', '#999'), { rules, spec, rowlessLandings: [40] }), [], 'another item\'s trailer exempts nothing');
    }
  }
  assert.equal(landingMessage({ ...item, item_spec_ids: '', item_lane: 'docs' }).header, 'docs(merge): typed landing', 'no typed commit: the lane rule');
  assert.notDeepEqual(commitMsgProblems('feat(core): add it', { rules, spec }), [], 'a work commit still cites its rows');
  assert.notDeepEqual(commitMsgProblems('feat(merge): add it', { rules, spec }), [], 'a merge header without its item trailer still cites rows');
});


test('a hundred-character landing title shortens before dropping five header ids [B3,R3,C7]', () => {
  const rows = ['A1', 'B2', 'C7', 'R3', 'V4'];
  for (const title of ['x'.repeat(100), 'a long landing title '.repeat(5)]) {
    const built = landingMessage({ item_id: 2292, item_lane: 'core', item_title: title, item_spec_ids: rows.join(',') }, { type: 'fix' });
    const parsed = parseCommitMessage(built.message);
    assert.ok(built.header.length <= HEADER_LIMIT, built.header);
    assert.equal(parsed.type, 'fix');
    assert.deepEqual(parsed.shown, rows);
    assert.equal(parsed.more, 0);
    assert.deepEqual(parsed.rows, rows);
    assert.deepEqual(commitMessageProblems(built.message, { item: 2292, rows }), []);
  }
});
