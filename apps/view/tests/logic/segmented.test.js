/** The shared segmented HTML component takes explicit choices without DOM reach [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { segmentedToggle } from '../../src/logic/segmented.js';

test('the shared segmented component escapes labels, values and counts and exposes each pressed state [N26]', () => {
  const html = segmentedToggle({ label: 'A "group"', attribute: 'data-rows', value: 'chosen', options: [
    { value: 'chosen', label: 'Chosen', count: 0 }, { value: '" onclick="unsafe', label: '<script>unsafe</script>', count: '<b>unsafe</b>' },
  ] });
  assert.match(html, /role="group" aria-label="A &quot;group&quot;" data-segmented-control="data-rows"/u);
  assert.match(html, /data-rows="chosen" aria-pressed="true" class="on"><span class="seg-label">Chosen<\/span><b>0<\/b>/u);
  assert.match(html, /data-rows="&quot; onclick=&quot;unsafe" aria-pressed="false"/u);
  assert.ok(html.includes('&lt;script&gt;unsafe&lt;/script&gt;</span><b>&lt;b&gt;unsafe&lt;/b&gt;</b>'));
  assert.doesNotMatch(html, /<script>| onclick="/u);
  assert.throws(() => segmentedToggle({ label: 'Unsafe', attribute: 'onclick', options: [] }), /Unsupported segmented control action/u);
});
