/** @pullboard-test-input apps/cli/journeys/spec/revision.test.js apps/cli/journeys/spec/cockpit/*.test.js apps/cli/journeys/spec/cockpit/registry-10596.json */
/** The ten view-owned spec journey files carry stable IDs and one record each [C7,U148,#10596]. @pullboard-world-pin: the check reads the ten sibling test files and their registry by path; no fixture can say what their titles are. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const TITLE_ID = /^test\('([a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+): /gmu;
const TESTS = /^test\(/gmu;
const FILES = ['revision', 'cockpit/boards', 'cockpit/decisions', 'cockpit/list', 'cockpit/pointer', 'cockpit/rows', 'cockpit/script', 'cockpit/shared', 'cockpit/tab-speed-stage-timeout', 'cockpit/tab-speed-trace'];

test('cli.journeys-spec-cockpit-registered.ten-files-registered: clause 1: [C7,U148] every test in the ten view-owned spec journey files has a cli.journeys-spec-<file>.<slug> title ID and a record in registry-10596.json', () => {
  const records = JSON.parse(readFileSync(new URL('./registry-10596.json', import.meta.url), 'utf8'));
  const seen = new Set();
  for (const name of FILES) {
    const source = readFileSync(new URL(`../${name}.test.js`, import.meta.url), 'utf8');
    const ids = [...source.matchAll(TITLE_ID)].map((match) => match[1]);
    assert.equal(ids.length, [...source.matchAll(TESTS)].length, `${name}: every test title starts with an ID`);
    const prefix = `cli.journeys-spec-${name.replace('/', '-')}.`;
    for (const id of ids) {
      assert.ok(id.startsWith(prefix), `${name}: ${id} starts with ${prefix}`);
      assert.ok(records[id], `${name}: ${id} has a record in registry-10596.json`);
      seen.add(id);
    }
  }
  for (const id of Object.keys(records)) if (!id.startsWith('cli.journeys-spec-cockpit-registered.')) assert.ok(seen.has(id), `record ${id} names no test`);
});
