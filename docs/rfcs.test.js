/** @pullboard-test-input docs/rfcs/0006-cells.md SPEC.md DOCTRINE.md */
/** RFC 0006 retains its approved text and gives every decided design rule a fresh permanent row [D1,D3]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseSpec } from '../packages/spec/index.js';

const RFC = new URL('./rfcs/0006-cells.md', import.meta.url);
const UNDECIDED = new Set(['R3', 'R8', 'R41', 'R43', 'R46']);

/** Read the RFC's explicit, bounded appendix independently of its historical design citations. */
function mappedRows(source) {
  const appendix = source.split('<!-- cells-rule-map:start -->')[1]?.split('<!-- cells-rule-map:end -->')[0];
  assert.ok(appendix, 'the RFC supplies its marked row mapping');
  return [...appendix.matchAll(/^\| ([KSRG]\d+) \| (C[SD]\d+) \| (SPEC\.md|DOCTRINE\.md) \|$/gmu)]
    .map(([, design, id, file]) => ({ design, id, file }));
}

test('RFC 0006 keeps the approved cells body unchanged [D1,D3]', () => {
  const source = readFileSync(RFC, 'utf8');
  assert.match(source, /^# RFC 0006: Cells,/u);
  assert.match(source, /^- Status: Accepted\.$/mu);
  const body = source.slice(source.indexOf('## Summary')).split('\n<!-- cells-rule-map:start -->')[0];
  assert.equal(createHash('sha256').update(body).digest('hex'), 'f1ff948d97cf9ce265f9dbcaf8c930bae0583f940dc5712110cca5521bed8e7e', 'the approved body is verbatim');
});

test('every decided RFC 0006 rule resolves to a new spec or doctrine row [D1,D3]', () => {
  const source = readFileSync(RFC, 'utf8');
  const body = source.split('<!-- cells-rule-map:start -->')[0];
  const cited = new Set([...body.matchAll(/\[([KSRG]\d+(?:, [KSRG]\d+)*)\]/gu)].flatMap(match => match[1].split(', ')));
  const decided = [...cited].filter(id => !UNDECIDED.has(id)).sort();
  const mapping = mappedRows(source);
  assert.equal(new Set(mapping.map(row => row.design)).size, mapping.length, 'every decided design citation is mapped once');
  assert.deepEqual(mapping.map(row => row.design).sort(), decided);
  const rows = new Map(['SPEC.md', 'DOCTRINE.md'].map(file => [file,
    parseSpec(readFileSync(new URL('../' + file, import.meta.url), 'utf8')).rows]));
  const targets = new Set();
  for (const entry of mapping) {
    assert.equal(UNDECIDED.has(entry.design), false, 'an undecided item gets no row');
    assert.notEqual(entry.id, entry.design, 'design ids are never reused');
    const matches = rows.get(entry.file).filter(row => row.id === entry.id);
    assert.equal(matches.length, 1, entry.id + ' resolves exactly once');
    assert.equal(matches[0].status, 'approved', entry.id + ' records the approved rule');
    assert.match(matches[0].text, /RFC 0006/u, entry.id + ' cites its RFC');
    targets.add(entry.file + ':' + entry.id);
  }
  const perTarget = new Map();
  for (const entry of mapping) perTarget.set(entry.file + ':' + entry.id, (perTarget.get(entry.file + ':' + entry.id) ?? 0) + 1);
  assert.equal(targets.size, perTarget.size, 'every target row is counted once');
  for (const [target, count] of perTarget) assert.ok(count <= 2, target + ' is shared by at most one pair of design rules');
  assert.equal([...perTarget.values()].reduce((sum, count) => sum + count, 0), mapping.length, 'every mapped rule lands on a target row');
});
