/** @pullboard-world-pin: block and documentedEvents read docs/formats.md itself, the guide both format tests check. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const guide = readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'docs', 'formats.md'), 'utf8');

/** Return the text inside a named marked documentation block. */
export function block(start, end) {
  const begin = guide.indexOf(start);
  const finish = guide.indexOf(end, begin + start.length);
  assert.notEqual(begin, -1, `guide has block start ${start}`);
  assert.notEqual(finish, -1, `guide has block end ${end}`);
  return guide.slice(begin + start.length, finish);
}

/** Parse the event manifest and compare it with event rows produced by real board operations. */
export function documentedEvents() {
  const lines = block('<!-- events:start -->', '<!-- events:end -->').split(/\r?\n/);
  const result = {};
  for (const line of lines) {
    const row = /^\| `([^`]+)` \| ([^|]+) \| (.+) \|$/.exec(line);
    if (!row) continue;
    const [, kind, actor, fields] = row;
    result[kind] = { actor: actor.trim(), fields: [...fields.matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort() };
  }
  return result;
}
