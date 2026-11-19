/** @pullboard-test-input apps/cli/journeys/shout/shouts.test.js apps/cli/journeys/shout/fixture.test.js apps/cli/journeys/shout/journeys/fixture-*.test.js apps/cli/journeys/shout/journeys/registry-10595.json apps/cli/tests/fixtures/registry-10550.json */
/** The nine view-owned shout journey files carry stable IDs and one record each [C7,U148,#10595]. @pullboard-world-pin: the check reads the nine sibling test files and their registry by path; no fixture can say what their titles are. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const TITLE_ID = /^test\('([a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+): /gmu;
const TESTS = /^test\(/gmu;
const FILES = ['shouts', 'fixture', 'journeys/fixture-api', 'journeys/fixture-connections', 'journeys/fixture-foreground', 'journeys/fixture-presentation', 'journeys/fixture-setup', 'journeys/fixture-transport', 'journeys/fixture-undeclared'];

test('cli.journeys-shout-journeys-registered.nine-files-registered: clause 1: [C7,U148] every test in the nine view-owned shout journey files has a cli.journeys-shout-<file>.<slug> title ID and a record in registry-10595.json or the landed registry-10550.json', () => {
  const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const own = read('./registry-10595.json');
  const records = { ...read('../../../tests/fixtures/registry-10550.json'), ...own };
  const seen = new Set();
  for (const name of FILES) {
    const source = readFileSync(new URL(`../${name}.test.js`, import.meta.url), 'utf8');
    const ids = [...source.matchAll(TITLE_ID)].map((match) => match[1]);
    assert.equal(ids.length, [...source.matchAll(TESTS)].length, `${name}: every test title starts with an ID`);
    const prefix = `cli.journeys-shout-${name.replace('/', '-')}.`;
    for (const id of ids) {
      assert.ok(id.startsWith(prefix), `${name}: ${id} starts with ${prefix}`);
      assert.ok(records[id], `${name}: ${id} has a record in registry-10595.json`);
      seen.add(id);
    }
  }
  for (const id of Object.keys(own)) if (!id.startsWith('cli.journeys-shout-journeys-registered.')) assert.ok(seen.has(id), `record ${id} names no test`);
});
