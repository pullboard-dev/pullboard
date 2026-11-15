/** pullboard explain prints a table's guards in order with each code and next step, as text and as JSON, and refuses an unknown table [C7,#8072]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const MOVES = pathToFileURL(fileURLToPath(new URL('../../../../packages/moves/index.js', import.meta.url))).href;

test('clause 1, 2 and 3: explain prints guards in order, as JSON too, and refuses an unknown table [C7,#8072]', async () => {
  const box = e2e.project();
  mkdirSync(join(box.web, 'packages/demo/src/logic'), { recursive: true });
  writeFileSync(join(box.web, 'packages/demo/src/logic/demo.table.js'), `
    import { defineRules } from ${JSON.stringify(MOVES)};
    export const DEMO_RULES = defineRules({ known: { says: 'the move is known', holds: () => true }, mine: { says: 'the caller holds the claim', holds: () => true } });
    export const DEMO_TABLE = { name: 'demo', guards: [
      { id: 'known', requires: 'known', code: 'UNKNOWN', message: 'm', next: 'pick a known move' },
      { id: 'mine', requires: 'mine', code: 'NOT_YOURS', message: 'm', next: 'claim it first' }],
      outcomes: [{ id: 'plain', patch: () => ({}), events: () => [] }] };`);
  const text = await box.runLocal(box.web, 'explain', 'demo');
  assert.equal(text.code, 0, `${text.out}\n${text.err}`);
  const lines = text.out.trim().split('\n');
  assert.equal(lines[0], 'table demo');
  assert.match(lines[1], /^ {2}1\. known: .*UNKNOWN, next: pick a known move$/u);
  assert.match(lines[2], /^ {2}2\. mine: .*NOT_YOURS, next: claim it first$/u);
  const json = JSON.parse((await box.runLocal(box.web, 'explain', 'demo', '--json')).out);
  assert.deepEqual(json.guards.map(guard => [guard.order, guard.id, guard.code, guard.next]), [[1, 'known', 'UNKNOWN', 'pick a known move'], [2, 'mine', 'NOT_YOURS', 'claim it first']]);
  const unknown = await box.runLocal(box.web, 'explain', 'nope');
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.err, /EXPLAIN_TABLE.*demo/su);
});
