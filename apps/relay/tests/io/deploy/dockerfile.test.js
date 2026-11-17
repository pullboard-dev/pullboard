/** @pullboard-test-input apps/relay/src/io/deploy/Dockerfile package.json CHANGELOG.md apps packages */
/** The relay image copies only paths that exist after the layout freeze, each once [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
/** @pullboard-world-pin: the test reads the shipped Dockerfile and checks its COPY sources against the tree. */
const DOCKERFILE = join(ROOT, 'apps', 'relay/src/io/deploy/Dockerfile');

/** Read each COPY instruction as its source paths, ignoring flags and the destination. */
function copySources() {
  const out = [];
  for (const line of readFileSync(DOCKERFILE, 'utf8').split('\n')) {
    const match = /^COPY\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const words = match[1].split(/\s+/).filter((word) => !word.startsWith('--'));
    out.push(...words.slice(0, -1));
  }
  return out;
}

test('every COPY source in the relay Dockerfile exists in the repository [C7]', () => {
  const sources = copySources();
  assert.ok(sources.length > 0);
  for (const source of sources) assert.ok(existsSync(join(ROOT, source)), `${source} is missing`);
});

test('no COPY source is copied twice [C7]', () => {
  const sources = copySources().map((source) => source.replace(/\/+$/, ''));
  assert.deepEqual(sources.filter((source, i) => sources.indexOf(source) !== i), []);
});

test('the relay Dockerfile names no old root folder [C7]', () => {
  const text = readFileSync(DOCKERFILE, 'utf8');
  for (const folder of ['src', 'bin', 'relay', 'test']) {
    assert.doesNotMatch(text, new RegExp(`(^|\\s)${folder}/`, 'm'), `${folder}/ is a pre-move root folder`);
  }
});
