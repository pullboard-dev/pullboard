/** @pullboard-test-input packages/store/src/logic/exit/rules/continuation.js */
/** @pullboard-world-pin walks the shipped continuation.js's static import statements to prove it reaches the state package only through its light door. */
/**
 * The exit continuation rule reads the engine numbers from the state light door, so the state barrel, and the state machine under it, stay out of every light command's cold load [C7,#6480].
 * Why a static read: the modules a file loads are the ones its import statements name, so no process is launched.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';

const FILE = resolve(import.meta.dirname, '../../../../src/logic/exit/rules/continuation.js');
const STATE = resolve(import.meta.dirname, '../../../../../state');
const STATIC_IMPORT = /^\s*(?:import|export)\s[^'"`;]*?from\s*['"](\.[^'"]+)['"]|^\s*import\s*['"](\.[^'"]+)['"]/gmu;

/** The modules continuation.js names in its static import and re-export statements, as absolute paths. */
function staticImports() {
  return [...readFileSync(FILE, 'utf8').matchAll(STATIC_IMPORT)].map(match => resolve(dirname(FILE), match[1] ?? match[2]));
}

test('store.logic-exit-rules-continuation.state-imports-only-light-door: clause 2: continuation.js names no state module but the light door, so neither the state barrel nor the state machine is reached [C7,#6480]', () => {
  const fromState = staticImports().filter(path => path.startsWith(`${STATE}/`));
  assert.ok(fromState.length > 0, 'continuation.js still imports the engine numbers from the state package');
  assert.deepEqual(fromState, fromState.map(() => `${STATE}/light.js`), 'every state import is the light door');
});
