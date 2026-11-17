/** @pullboard-test-input source-cell gate */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { affectedCommand } from '../../src/io/test/affected-command.js';

test('gate.affected-command-unit.one-per-unit: clause 1: a cargo command holding {unit} and two crates returns one command per unit, sorted, shell-quoted and joined with && [C7]', () => {
  const config = { affectedTests: 'cargo test -p {unit}' };
  assert.equal(affectedCommand(config, ['zeta', "it's"], 'crate'), "cargo test -p 'it'\\''s' && cargo test -p 'zeta'");
  assert.equal(affectedCommand(config, ['b', 'a', 'a'], 'crate'), "cargo test -p 'a' && cargo test -p 'b'");
});

test('gate.affected-command-unit.both-forms-refused: clause 2: a command holding both {units} and {unit} is refused with SELECTION_UNIT_COMMAND naming both [C7]', () => {
  assert.throws(() => affectedCommand({ affectedTests: 'cargo test {unit} {units}' }, ['a'], 'crate'),
    error => error.code === 'SELECTION_UNIT_COMMAND' && error.message.includes('{units}') && error.message.includes('{unit}'));
});

test('gate.affected-command-unit.others-unchanged: clause 3: the file unit and the {units} form return byte for byte what they return today [C7]', () => {
  assert.equal(affectedCommand({ affectedTests: 'node --test  ' }, ['a/b.test.js']), "node --test './a/b.test.js'");
  assert.equal(affectedCommand({ affectedTests: 'go test {units} -count=1' }, ['pkg/a', 'cmd/app'], 'package'), "go test './cmd/app' './pkg/a' -count=1");
  assert.equal(affectedCommand({ affectedTests: 'cargo test -p {unit}' }, ['x'], 'file'), "cargo test -p {unit} './x'");
});
