/** Keep the public API guide aligned with the CLI's versioned shape catalog [A1]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSON_SHAPES } from '../src/json.js';

const guide = readFileSync(new URL('./api.md', import.meta.url), 'utf8');

/** Read a marked Markdown shape table as a map of names to required field/type pairs. */
function readShapeTable(start, end) {
  const begin = guide.indexOf(start);
  const finish = guide.indexOf(end, begin + start.length);
  assert.notEqual(begin, -1, 'guide has opening table marker');
  assert.notEqual(finish, -1, 'guide has closing table marker');
  const section = guide.slice(begin + start.length, finish);
  const rows = new Map();
  for (const line of section.split(/\r?\n/)) {
    const row = /^\| \x60([^\x60]+)\x60 \| (.+) \|$/.exec(line);
    if (!row) continue;
    const fields = [...row[2].matchAll(/\x60([^:\x60]+):([^\x60]+)\x60/g)].map((match) => [match[1], match[2]]);
    assert.ok(fields.length, 'shape row lists fields: ' + row[1]);
    assert.equal(rows.has(row[1]), false, 'shape row is unique: ' + row[1]);
    rows.set(row[1], Object.fromEntries(fields));
  }
  return Object.fromEntries(rows);
}

test('[A1] API guide documents every CLI result and refusal shape from the source catalog', () => {
  assert.match(guide, /stable within each major API version/);
  assert.match(guide, /incompatible change requires a new \x60version\x60/);

  const documentedCommands = readShapeTable('<!-- api-command-shapes:start -->', '<!-- api-command-shapes:end -->');
  const sourceCommands = Object.fromEntries(Object.entries(JSON_SHAPES.commands).map(([name, shape]) => [name, shape.required]));
  assert.deepEqual(documentedCommands, sourceCommands);

  const documentedRefusals = readShapeTable('<!-- api-refusal-shapes:start -->', '<!-- api-refusal-shapes:end -->');
  assert.deepEqual(documentedRefusals.envelope, JSON_SHAPES.error.required);
  assert.deepEqual(documentedRefusals.error, JSON_SHAPES.errorFields);
  assert.deepEqual(Object.keys(documentedRefusals).sort(), ['envelope', 'error']);
});

test('[A2] API guide documents the local HTTP response catalog', () => {
  const documented = readShapeTable('<!-- api-http-shapes:start -->', '<!-- api-http-shapes:end -->');
  const source = Object.fromEntries(Object.entries(JSON_SHAPES.http).map(([name, shape]) => [name, shape.required]));
  assert.deepEqual(documented, source);
});
