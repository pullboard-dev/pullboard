/** @pullboard-test-input apps/view/src/io/page/actions.js */
/** @pullboard-world-pin reads actions.js source to prove the page-controls gate; the control itself needs a browser. */
/** The New item control shows on a relay page when the person may make requests [H12,#7024]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const SOURCE = readFileSync(new URL('../../../src/io/page/actions.js', import.meta.url), 'utf8');

test('view.x-io-page-new-item-control.clause-1-the-page-controls-are-writable: clause 1: the page controls are writable for a read-only page that takes requests [H12,#7024]', () => {
  const draw = SOURCE.slice(SOURCE.indexOf('function drawPageControls()'));
  const gate = /writable: ([^}]*?) \}\);/u.exec(draw.slice(0, draw.indexOf('\n}\n')));
  assert.ok(gate, 'drawPageControls passes a writable flag');
  const writable = (snapshot, readOnly, requests) => new Function('snapshot', 'readOnly', 'requests', `return ${gate[1]};`)(snapshot, readOnly, requests);
  assert.equal(writable(false, true, true), true, 'relay person with requests sees the control');
  assert.equal(writable(false, true, false), false, 'a plain read-only view does not');
  assert.equal(writable(true, true, true), false, 'a snapshot never does');
  assert.equal(writable(false, false, false), true, 'a writable view does');
});
