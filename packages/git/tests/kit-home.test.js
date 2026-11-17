/** @pullboard-test-input source-cell git */
/** No test under packages/git/tests imports a module of the CLI fixture kit, which only re-exports package homes [C7]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const TESTS = import.meta.dirname;
const KIT_IMPORT = /\b(?:import|export)\b[^;'"`]*?\bfrom\s*['"][^'"]*apps\/cli\/tests\/fixtures\/[^'"]*['"]/u;

test('clause 1: no test under packages/git/tests imports a module of the CLI fixture kit [C7]', () => {
  const offenders = readdirSync(TESTS, { recursive: true })
    .filter((name) => /\.test\.m?js$/u.test(name) && !name.split('/').includes('node_modules'))
    .filter((name) => KIT_IMPORT.test(readFileSync(join(TESTS, name), 'utf8')));
  assert.deepEqual(offenders, [], 'package tests import the kit from its package home');
});
