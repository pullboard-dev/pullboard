/** @pullboard-test-input source-cell gate */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { affectedCommand } from '../../../src/io/test/affected-command.js';

test('gate.affected-command-units.file-unchanged: clause 1: with gate.selectionUnit file (the default) affectedCommand returns exactly the string it returns today [C7]', () => {
  const config = { affectedTests: 'node --test  ' };
  const files = ['a/b.test.js', "it's.test.js"];
  const today = `node --test './a/b.test.js' './it'\\''s.test.js'`;
  assert.equal(affectedCommand(config, files), today);
  assert.equal(affectedCommand(config, files, 'file'), today);
  assert.equal(affectedCommand({ affectedTests: 'go test {units}' }, files), "go test {units} './a/b.test.js' './it'\\''s.test.js'");
});

test('gate.affected-command-units.placeholder-filled: clause 2: another unit shell-quotes each unit in place of {units}, and a command without it is refused naming gate.selectionUnit [C7]', () => {
  assert.equal(affectedCommand({ affectedTests: 'go test {units} -count=1' }, ['pkg/a', 'cmd/app'], 'package'), "go test 'cmd/app' 'pkg/a' -count=1");
  assert.equal(affectedCommand({ affectedTests: 'cargo test -p {units}' }, ['x y'], 'crate'), "cargo test -p 'x y'");
  assert.throws(() => affectedCommand({ affectedTests: 'go test' }, ['pkg/a'], 'package'), (error) => error.code === 'SELECTION_UNIT_COMMAND' && /gate\.selectionUnit/u.test(error.message) && /\{units\}/u.test(error.message));
});

test('gate.affected-command-units.order-independent: clause 3: the same units in a different order give the same string [C7]', () => {
  const config = { affectedTests: 'dotnet test {units}' };
  assert.equal(affectedCommand(config, ['b', 'a', 'a'], 'project'), affectedCommand(config, ['a', 'b'], 'project'));
});
