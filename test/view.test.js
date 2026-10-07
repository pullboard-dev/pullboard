/**
 * The spec view (S7): one offline page with the spec, open questions, sign-offs and practice, where
 * no text from the files can inject markup.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec } from '../src/spec.js';
import { standardDoctrine } from '../src/doctrine.js';
import { esc, renderSpecView } from '../src/view.js';

const SPEC = `# Bakery spec

Pre-orders for four shops.

## O · Orders
- O1 [approved, must] Orders lock at 2pm the day before pickup. | gate: lock test
- O2 [approved, must] A confirmation text names the shop. | gate: text test
- O3 [pending] Can a customer cancel after the lock?
- O4 [draft, aim] Show <script>alert(1)</script> nowhere. | gate: xss test
`;

/**
 * The page for the sample spec, with O1 signed on its current text and O2 signed on older text.
 */
function page(practice = standardDoctrine()) {
  const spec = { ...parseSpec(SPEC), exists: true };
  const signoffs = [
    { id: 'O1', by: 'CO', on: '2026-10-05', text: 'Orders lock at 2pm the day before pickup.' },
    { id: 'O2', by: 'CO', on: '2026-10-04', text: 'A text names the shop.' },
  ];
  return renderSpecView({
    title: spec.title,
    spec,
    practice,
    signoffs,
    generatedAt: '2026-10-05 12:00',
    files: { spec: 'SPEC.md', practice: 'PRACTICE.md' },
  });
}

test('one self-contained page with every tab and inherited doctrine row [S7,D1,D3]', () => {
  const html = page();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!/src="http|href="http/.test(html), 'nothing loads from the network');
  for (const label of ['Spec', 'Open questions (1)', 'Sign-off', 'Practice']) assert.ok(html.includes(label));
  for (const id of ['O1', 'O2', 'O3', 'O4', 'PB1', 'PB12']) assert.ok(html.includes(`>${id}<`), `${id} is on the page`);
});

test('legacy repo practice rows still render without being replaced [S7,D4]', () => {
  const practice = { ...parseSpec('# Legacy practice\n\n## Writing\n- W1 [fact] A local writing rule.\n\n## Git\n- G4 [fact] A local Git rule.\n'), exists: true };
  const html = page(practice);
  for (const id of ['W1', 'G4']) assert.ok(html.includes(`>${id}<`), `${id} remains on the page`);
});

test('sign-offs show as signed, stale or not signed [S5, S7]', () => {
  const html = page();
  assert.ok(html.includes('signed CO 2026-10-05'));
  assert.ok(html.includes('stale: text changed since sign-off'));
  assert.ok(html.includes('<b>1/2</b><span>approved must-rows signed</span>'));
});

test('row text is escaped, so a row cannot inject markup', () => {
  const html = page();
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(esc(`a<b>"c"&'d'`), 'a&lt;b&gt;&quot;c&quot;&amp;&#39;d&#39;');
});
