/** @pullboard-test-input source-cell packages/items */
/** The items vendors module holds no list of vendor environment variables, only vendor spellings read from vendors.json [C7,#6897]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '../../..');
const ENTRY = resolve(ROOT, 'packages/items/src/logic/vendors.js');
const SOURCE = readFileSync(ENTRY, 'utf8');
const ENV_NAME = /["'`][A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+["'`]/u;

test('items.no-vendor-env.vendors-hold-no-env-list: clause 1: vendors.js names no vendor environment variable and never reads process.env [C7,#6897]', () => {
  assert.doesNotMatch(SOURCE, /process\.env/u);
  assert.doesNotMatch(SOURCE, ENV_NAME);
  assert.doesNotMatch(SOURCE, /\b(?:ANTHROPIC|OPENAI|GOOGLE|GEMINI|CODEX|CLAUDE)_[A-Z0-9_]+/u);
  assert.match(SOURCE, /import VENDORS from ['"]\.\/vendors\.json['"]/u);
});
