/** pullboard replay prints the agreed, disagreed and before-cut counts with each disagreement's event id, as text and as JSON, and refuses an unknown table [C7,#8071]. */
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

test('clause 1, 2 and 3: replay reports counts and event ids, as JSON too, and refuses an unknown table [C7,#8071]', async () => {
  const box = e2e.project();
  mkdirSync(join(box.web, 'packages/demo/src/logic'), { recursive: true });
  writeFileSync(join(box.web, 'packages/demo/src/logic/demo.table.js'), `
    import { defineRules } from ${JSON.stringify(MOVES)};
    export const DEMO_RULES = defineRules({ known: { says: 'the move is known', holds: () => true } });
    export const DEMO_TABLE = { name: 'demo', guards: [{ id: 'known', requires: 'known', code: 'UNKNOWN', message: 'm', next: 'n' }],
      outcomes: [{ id: 'plain', patch: () => ({}), events: (s, m) => [{ kind: 'demo', by: m.actor, detail: {} }] }] };`);
  const text = await box.runLocal(box.web, 'replay', 'demo', '--days', '30');
  assert.equal(text.code, 0, `${text.out}\n${text.err}`);
  assert.match(text.out, /^replay demo: \d+ agreed, \d+ disagreed, \d+ before the cut/u);
  assert.match(text.out, /\n {2}event \d+: board /u, 'the board recorded moves the demo table does not write, so each is listed with its event id');
  const json = JSON.parse((await box.runLocal(box.web, 'replay', 'demo', '--json')).out);
  assert.deepEqual(Object.keys(json).filter(key => ['version', 'agreed', 'disagreed', 'beforeCut'].includes(key)).sort(), ['agreed', 'beforeCut', 'disagreed', 'version']);
  const unknown = await box.runLocal(box.web, 'replay', 'nope');
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.err, /REPLAY_TABLE.*demo/su);
});
