/** Generated browser-script contract; this is code generation, not a pure-renderer witness. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';
import { pageRenderScript } from '../../../../index.js';

test('page renderer embeds the pure Agents model and HTML renderer as parseable script [N26]', () => {
  const source = pageRenderScript();
  assert.match(source, /const agentsPanelModel = \(/u);
  assert.match(source, /const shoutsModel = \(/u);
  assert.match(source, /const shoutsHtml = \(/u);
  assert.match(source, /const agentsPanelHtml = \(/u);
  new vm.Script(source, { filename: 'generated-page-render.js' });
});
