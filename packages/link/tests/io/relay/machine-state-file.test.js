/** @pullboard-test-input source-cell link */
/** @pullboard-world-pin reads machine.js to prove it builds no state.json path and takes the path from the store. The relay machine module names no state.json path of its own: it reads and writes the state file through the store's relayMachineStateFile [C7,#9587]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const SOURCE = readFileSync(join(import.meta.dirname, '../../../src/io/relay/machine.js'), 'utf8');

test('link.io-relay-machine-state-file.state-path-from-store: clause 1: machine.js builds no state.json path of its own and reads and writes the state file through relayMachineStateFile [C7]', () => {
  assert.doesNotMatch(SOURCE, /state\.json/u, 'no state.json path is built in machine.js');
  assert.match(SOURCE, /import \{ relayMachineStateFile \} from '[./]*store\/index\.js'/u, 'relayMachineStateFile comes from the store door');
  assert.ok(SOURCE.split('relayMachineStateFile()').length - 1 >= 2, 'the read and the write each take the path from relayMachineStateFile()');
});
