/** @pullboard-test-input docs-tree */
/** @pullboard-test-input apps/cli/src/logic/help.js */
/** @pullboard-world-pin reads every page under docs/design to check its sections, and the help text to check the CLI mapping. */
/** Every design page under docs/design/ is a proposal that names its open decisions and its items, and the CLI design maps every command [C7,N26]. */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { commandPhrases } from '../apps/cli/src/logic/help.js';

const DIR = new URL('./design/', import.meta.url);
const pages = readdirSync(DIR).filter((name) => name.endsWith('.md'));

/** The bullets under one `## ` heading of a page, or an empty list when the heading is missing. */
function bullets(page, heading) {
  const start = page.search(new RegExp(`^## ${heading}$`, 'mu'));
  if (start < 0) return [];
  const rest = page.slice(start).split('\n').slice(1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).filter((line) => line.startsWith('- '));
}

test('docs/design holds at least one design page [C7,N26]', () => {
  assert.ok(pages.length > 0, 'docs/design/ has no page');
});

for (const name of pages) {
  test(`${name} is a proposal that names its open decisions and its items [C7,N26]`, () => {
    const page = readFileSync(new URL(name, DIR), 'utf8');
    assert.match(page, /^# Design: .+/u, 'the title starts with "Design: "');
    assert.match(page, /^Status: a proposal for the person\. Nothing here is built\.$/mu);
    assert.ok(bullets(page, 'Open decisions for the person').length >= 3, 'at least three open decisions');
    assert.ok(bullets(page, 'Items building it would need').length >= 3, 'at least three items');
    assert.doesNotMatch(page, /\b(?:revolutionary|world-class|seamless|best-in-class)\b/iu);
  });
}

const CLI_PAGE = new URL('cli-least-confusion.md', DIR);

test('the CLI design maps every command the help prints to a fate and a new place [C7,N26]', { skip: !existsSync(CLI_PAGE) && 'the CLI design page is not in this tree' }, () => {
  const file = CLI_PAGE;
  const page = readFileSync(file, 'utf8');
  const fates = new Set(['kept', 'moved under admin', 'folded into stats', 'removed']);
  const mapped = new Map();
  for (const line of page.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const match = /^`([a-z][a-z0-9-]*)`$/u.exec(cells[1] ?? '');
    if (match && fates.has(cells[2])) mapped.set(match[1], cells[2]);
  }
  const commands = [...new Set(commandPhrases().map((phrase) => phrase.split(' ')[0]))];
  const missing = commands.filter((command) => !mapped.has(command));
  assert.deepEqual(missing, [], `commands with no row in the mapping: ${missing.join(', ')}`);
  const kept = [...mapped].filter(([command, fate]) => fate === 'kept' && !['help', 'version'].includes(command));
  assert.ok(kept.length >= 9 && kept.length <= 12, `about ten person commands at the top level, found ${kept.length}`);
  for (const [pair, single] of [['lanes', 'lane'], ['hooks', 'hook'], ['sentinels', 'sentinel']]) {
    assert.equal(mapped.get(pair), 'removed', `${pair} is the plural twin of ${single}`);
  }
});
