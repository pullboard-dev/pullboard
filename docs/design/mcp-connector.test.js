/** @pullboard-test-input source-tree */
/** @pullboard-world-pin reads the shipped MCP connector design to check its required sections. */
/** The MCP connector design has every section the item asks for [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const DOC = readFileSync(resolve(import.meta.dirname, 'mcp-connector.md'), 'utf8');

test('the connector design has every required section [N26]', () => {
  for (const heading of [
    '## Tools',
    '## Sign-in and reaching a board',
    '## What a chat agent may and may not do',
    '## How approvals reach the person',
    '## Smallest first version',
    '## Open decisions for the person',
    '## Items building it would need',
  ]) {
    assert.ok(DOC.includes(`\n${heading}\n`), heading);
  }
});

test('the connector design lists today\'s nine tools and says chat never acts as the person [N26]', () => {
  for (const tool of ['board_status', 'show_item', 'shout', 'capture_idea', 'next', 'claim', 'submit', 'verify', 'resume']) {
    assert.ok(DOC.includes(`\`${tool}\``), tool);
  }
  assert.match(DOC, /No tool approves, answers or signs off/);
});
