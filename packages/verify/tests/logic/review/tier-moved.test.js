/** @pullboard-test-input packages/codemap/data/plan/28-pages.json packages/codemap/data/plan/renames.tsv packages/verify/data/tests/guard.json */
/** @pullboard-world-pin reads the committed plan, rename and guard-test move data to prove no Strict path lost its tier in a cells move. */
/** A path marked Strict before a cells move is Strict at its new home, read from the plan, rename and guard-test data, never a second list [V4,B26,#2339]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gateJudgmentPath } from '../../../index.js';

const ROOT = new URL('../../../../../', import.meta.url);
const PLAN = new URL('packages/codemap/data/plan/', ROOT);
const GUARD_MOVED = JSON.parse(readFileSync(new URL('packages/verify/data/tests/guard.json', ROOT), 'utf8')).moved;
const PLANNED = readdirSync(PLAN).filter(name => name.endsWith('.json')).flatMap(name => JSON.parse(readFileSync(new URL(name, PLAN), 'utf8')).paths ?? []).map(([old, now]) => [old, now]);
const RENAMED = readFileSync(new URL('renames.tsv', PLAN), 'utf8').split('\n').filter(Boolean).map(line => line.split('\t'));
const NEXT = new Map([...PLANNED, ...RENAMED]);

/** Where a path ends up after every recorded move: a guard test's own move map wins, otherwise the plan and rename chain is followed to its end. */
function newHome(path) {
  if (GUARD_MOVED[path]) return GUARD_MOVED[path];
  const seen = new Set();
  let at = path;
  while (NEXT.has(at) && !seen.has(at)) { seen.add(at); at = NEXT.get(at); }
  return at;
}

// Paths inside packages/ or apps/ are already cell layouts: only the flat layout before the cells move had its own marks.
const STRICT_BEFORE = [...NEXT.keys()].filter(old => !/^(?:packages|apps)\//u.test(old) && gateJudgmentPath(old));

test('every path marked Strict before a cells move is Strict at its new home [V4,B26,#2339]', () => {
  assert.ok(STRICT_BEFORE.length > 0, 'the move data holds Strict paths to check');
  const lost = STRICT_BEFORE.filter(old => !gateJudgmentPath(newHome(old))).map(old => `${old} -> ${newHome(old)}`);
  assert.deepEqual(lost, [], 'moved bodies that came out Standard');
});

test('the pages cell\'s seven moved bodies keep the tier of their old paths [V4,B26,#2339]', () => {
  const pages = JSON.parse(readFileSync(new URL('28-pages.json', PLAN), 'utf8')).paths;
  assert.equal(pages.length, 7, 'the pages plan lists its seven moved bodies');
  const strict = pages.filter(([old]) => gateJudgmentPath(old));
  assert.ok(strict.length > 0, 'some old pages paths were Strict');
  for (const [old] of strict) assert.equal(gateJudgmentPath(newHome(old)), true, `${old} -> ${newHome(old)}`);
});
