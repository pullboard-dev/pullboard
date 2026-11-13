/** @pullboard-test-input apps/view/src/io/serve.js packages/api/src/io/http.js */
/** @pullboard-test-input docs-tree */
/** Keep the public API guide aligned with the CLI's versioned shape catalog [A1]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSON_SHAPES } from '../packages/config/index.js';

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
    const fields = [...row[2].matchAll(/\x60([^:\x60]+):([^\x60]+)\x60/g)].map((match) => [match[1], match[2].replaceAll('\\|', '|')]);
    assert.ok(fields.length, 'shape row lists fields: ' + row[1]);
    assert.equal(rows.has(row[1]), false, 'shape row is unique: ' + row[1]);
    rows.set(row[1], Object.fromEntries(fields));
  }
  return Object.fromEntries(rows);
}

test('[A1] API guide documents every CLI result and refusal shape from the source catalog', () => {
  assert.match(guide, /stable within each major API version/);
  assert.match(guide, /incompatible change requires a new \x60version\x60/);
  assert.match(guide, /agent may answer a decision sent to its own lane/);

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
  assert.match(guide, /`warnings` with its registry display fields and a versioned refusal/);
  assert.match(guide, /`GET \/api\/v1\/boards\/:board\/state\?seen=N`/);
  assert.match(guide, /`GET \/api\/v1\/boards\/:board\/state\?detail=full`/);
  assert.match(guide, /`GET \/api\/v1\/boards\/:board\/state\?since=N`/);
  assert.match(guide, /`BASE_NOT_KEPT`/);
  assert.match(guide, /`GET \/api\/v1\/boards\/:board\/items\/:id`/);
  assert.match(guide, /`GET \/api\/v1\/boards\/:board\/items\?q=text`/);
  assert.match(guide, /`ITEM_NOT_AVAILABLE`/);
  assert.match(guide, /`GET \/api\/v1\/boards\/:board\/code\?ref=path:lines@commit&before=\.\.\.`/);
  assert.match(guide, /`CODE_NOT_AVAILABLE` refusal/);
  assert.match(guide, /`event: changed` with `data: \{"version":1,"event":\{"event_kind":"changed"\}\}`/);
  assert.match(guide, /notification has no `id` and does not move the reconnect cursor/);
  assert.match(guide, /`GET \/api\/v1\/events\?boards=<id>,<id>`/);
  assert.match(guide, /`<id>:<sequence>` pairs joined by commas/);
});

/** Expand the simple alternation groups used by the HTTP router's path matchers. */
function expandRouteAlternatives(path) {
  const group = /\(([^()]*\|[^()]*)\)/u.exec(path);
  if (!group) return [path];
  return group[1].split('|').flatMap(value => expandRouteAlternatives(path.replace(group[0], value)));
}

/** Collect exact and patterned v1 paths dispatched by the local view and its API router. */
function routedV1Paths() {
  const sources = [
    readFileSync(new URL('../apps/view/src/io/serve.js', import.meta.url), 'utf8'),
    readFileSync(new URL("../packages/api/src/io/http.js", import.meta.url), 'utf8'),
  ];
  const paths = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/url\.pathname\s*===\s*'([^']+)'/gu)) {
      if (match[1].startsWith('/api/v1/')) paths.add(match[1]);
    }
  }
  for (const match of sources[1].matchAll(/const\s+\w+\s*=\s*(\/[^\r\n]*\/[a-z]*)\.exec\(url\.pathname\)/gu)) {
    let pattern = match[1].slice(1, match[1].lastIndexOf('/'));
    pattern = pattern.replace(/^\^/u, '').replace(/\$$/u, '').replaceAll('\\/', '/');
    pattern = pattern.replace('/boards/([^/]+)', '/boards/:board').replaceAll('([^/]+)', ':id');
    for (const path of expandRouteAlternatives(pattern)) {
      const normalized = path;
      if (normalized.startsWith('/api/v1/')) paths.add(normalized);
    }
  }
  return [...paths].sort();
}

test('[N26] every routed v1 path is documented', () => {
  const paths = routedV1Paths();
  assert.ok(paths.length > 0, 'the local view and API router expose versioned paths');
  const missing = paths.filter(path => !guide.includes(path));
  assert.deepEqual(missing, [], 'API guide documents every local view v1 path');
});
