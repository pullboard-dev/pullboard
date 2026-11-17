/** @pullboard-test-input source-cell gate */
/** A Go package unit reaches go test as a ./ path, and crate, project and file output stay as they were [C7,#10368]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { affectedCommand } from '../../../src/io/test/affected-command.js';

test('gate.affected-command.go-package-prefix: #10368 clause 1: package units give each nested folder a ./ prefix and leave the root as . [C7]', () => {
  const config = { affectedTests: 'go test {units}' };
  assert.equal(affectedCommand(config, ['pkg/a', 'cmd/app'], 'package'), "go test './cmd/app' './pkg/a'");
  assert.equal(affectedCommand(config, ['.', 'pkg/a'], 'package'), "go test '.' './pkg/a'");
  assert.equal(affectedCommand(config, ['.'], 'package'), "go test '.'");
});

test('gate.affected-command.crate-project-unchanged: #10368 clause 2: crate and project units are unchanged [C7]', () => {
  assert.equal(affectedCommand({ affectedTests: 'cargo test -p {unit}' }, ['zeta', 'a'], 'crate'), "cargo test -p 'a' && cargo test -p 'zeta'");
  assert.equal(affectedCommand({ affectedTests: 'dotnet test {units}' }, ['b/x.csproj', 'a/y.csproj'], 'project'), "dotnet test 'a/y.csproj' 'b/x.csproj'");
});

test('gate.affected-command.file-output-unchanged: #10368 clause 3: file unit output is byte for byte today [C7]', () => {
  assert.equal(affectedCommand({ affectedTests: 'node --test  ' }, ['a/b.test.js', "it's.test.js"]), "node --test './a/b.test.js' './it'\\''s.test.js'");
  assert.equal(affectedCommand({ affectedTests: 'go test {units}' }, ['pkg/a.go'], 'file'), "go test {units} './pkg/a.go'");
});
