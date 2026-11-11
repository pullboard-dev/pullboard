/** @pullboard-test-input apps/cli/src/io/documentation/*.json */
/** @pullboard-test-input apps/cli/src/io/documentation/events/*.json */
/** @pullboard-test-input source-tree */
/** @pullboard-test-input packages/codemap/data/plan/path-map/freeze.json */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { declarationDocBlocks } from '../../src/io/generated/declarations.js';
import { docsRepository } from '../../tests/fixtures/generated/docs.js';

test('frozen event identities remain exact and reject altered or duplicate declarations [A5,C7]', t => {
  const box = docsRepository(t);
  const dir = join(box.root, 'apps/cli/src/io/documentation/events');
  const original = readFileSync(join(dir, 'default.json'), 'utf8');
  const events = declarationDocBlocks(box.root).events;
  assert.match(events, /`review-default`/u);
  assert.match(events, /`health-scan`/u);
  const nestedPath = join(dir, 'health/scan.json');
  const nested = readFileSync(nestedPath, 'utf8');
  const wrongNested = JSON.parse(nested); wrongNested.kind = 'activity-acted';
  writeFileSync(nestedPath, JSON.stringify(wrongNested));
  assert.throws(() => declarationDocBlocks(box.root), /invalid event identity health\/scan\.json/u);
  writeFileSync(nestedPath, nested);
  const changed = JSON.parse(original); changed.kind = 'next-idle';
  writeFileSync(join(dir, 'default.json'), JSON.stringify(changed));
  assert.throws(() => declarationDocBlocks(box.root), /invalid event identity default\.json/u);
  writeFileSync(join(dir, 'default.json'), original);
  writeFileSync(join(dir, 'review-default.json'), original);
  assert.throws(() => declarationDocBlocks(box.root), /invalid event identity review-default\.json/u);
  unlinkSync(join(dir, 'review-default.json'));
  symlinkSync(join(dir, 'default.json'), join(dir, 'bad.json'));
  assert.throws(() => declarationDocBlocks(box.root), /invalid event declaration bad\.json/u);
});
