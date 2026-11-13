/** @pullboard-test-input source-tree */
/** @pullboard-world-pin reads panel.css, which the server adds to main.css at its marker, to prove the rules the page ships. */
/** The opened-item and preview panels draw cleanly: one header of aligned chips, a check sentence with a sized icon, no clipped row chip [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { composeViewStyles } from '../../../src/io/styles.js';
import { pageRenderScript } from '../../../src/io/page/render.js';

/** The served stylesheet and the item-panel rules the server adds at their marker. */
const css = composeViewStyles() + '\n' + readFileSync(new URL('../../../src/io/item/panel.css', import.meta.url), 'utf8');
/** Every declaration block for a selector, as the composed stylesheet has it. */
const rules = selector => [...css.matchAll(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + ' \\{([^}]*)\\}', 'gu'))].map(match => match[1]).join(' ');

test('clause 1: the opened item draws one header of chips, the same while it loads and once it has arrived [N26]', () => {
  const script = pageRenderScript();
  const head = script.slice(script.indexOf('const panelHead'), script.indexOf('const panelHead') + 1700);
  // One builder holds the lane, size and milestone chips, then the state and the holder as chips.
  assert.match(head, /where\.map\(part => '<span class="chip">'/u, 'lane, size and milestone are chips');
  assert.match(head, /<span class="chip holder"/u, 'the holder is a chip');
  assert.match(head, /stageMarkup\(item, p, gatedOf\(item\)[^;]*Boolean\(holderChip\)\)/u, 'the state is the stage chip, its holder line given to the holder chip');
  // The loading frame and the arrived panel both draw it, so the header never changes shape when the detail lands.
  assert.ok(script.includes("'<div class=\"item-panel\" aria-busy=\"true\">' + panelHead(selected) + '</div>'"), 'loading draws the panel header');
  assert.ok(script.includes("'<div class=\"item-panel\">' + panelHead(item, statusChips)"), 'the arrived panel draws the same header');
  assert.ok(!script.includes('<span class="chip">\' + esc(item.lane) + \'</span><span class="chip">\' + esc(item.route)'), 'no loose lane and size boxes beside the pill');
  assert.match(rules('.item-panel-where .chip, .item-panel-status > .chip'), /border-radius: var\(--radius-pill\)/u, 'the chips are one family of pills');
  assert.match(rules('.item-panel-status'), /min-height/u);
});

test('clause 2: the preview panel has no black block under Check and no clipped row chip [N26]', () => {
  // The flask in "Passes when <file>" is an inline svg: without its own size it fills a default box and draws solid black.
  assert.match(rules('.item-panel-check .file svg'), /width: 13px; height: 13px;[^}]*fill: none; stroke: currentColor;/u, 'the check sentence\'s icon has a size and an outline');
  assert.match(rules('.item-panel-check .file'), /display: inline-flex/u);
  // A row's marks and stage chip may be wider than the stage cell's old 10rem cap; nothing is cut at its left edge.
  assert.match(rules('#chain .row-side .item-stage'), /max-width: none; overflow: visible;/u, 'the stage cell of an Items row does not clip a mark beside the chip');
});
