/** @pullboard-test-input source-cell gate */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AFFECTED_LANGUAGES } from '../../src/logic/affected-rows.js';
import { affectedRow } from '../../src/logic/affected-rows.js';

test('gate.affected-rows.rows: clause 1: affectedRow gives each language its test command and selection unit [C7]', () => {
  const want = {
    python: ['pytest', 'file'], node: ['node --test', 'file'], go: ['go test {units}', 'package'],
    rust: ['cargo test --manifest-path {unit}/Cargo.toml', 'crate'], csharp: ['dotnet test {unit}', 'project'],
    php: ['vendor/bin/phpunit', 'file'], ruby: ['bundle exec rspec', 'file'], deno: ['deno test', 'file'], bun: ['bun test', 'file'],
  };
  for (const [language, [affectedTests, selectionUnit]] of Object.entries(want)) {
    assert.deepEqual(affectedRow(language), { affectedTests, selectionUnit, reason: null }, language);
  }
});

test('gate.affected-rows.no-guess: clause 2: cmake, make, maven, gradle and swift return null with a reason, never a guessed command [C7]', () => {
  for (const language of ['cmake', 'make', 'maven', 'gradle', 'swift', 'cobol']) {
    const row = affectedRow(language);
    assert.equal(row.affectedTests, null, language);
    assert.equal(row.selectionUnit, null, language);
    assert.match(row.reason, /full gate|affectedSuites/u, language);
  }
});

test('gate.affected-rows.placeholders: clause 3: every non-null row uses {units} or {unit} exactly when its unit is not file [C7]', () => {
  for (const language of AFFECTED_LANGUAGES) {
    const { affectedTests, selectionUnit } = affectedRow(language);
    if (affectedTests === null) continue;
    const placeholder = /\{units?\}/u.test(affectedTests);
    assert.equal(placeholder, selectionUnit !== 'file', language);
  }
});
