/** @pullboard-test-input source-cell gate */
/** Detected languages map to the runner toolchains they need [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LANGUAGE_ROWS } from '../../src/logic/language-rows.js';
import { TOOLCHAIN_LANGUAGES } from '../../src/logic/language-toolchains.js';
import { TOOLCHAIN_NAME } from '../../src/logic/language-toolchains.js';
import { languageToolchains } from '../../src/logic/language-toolchains.js';

/** The languages detectLanguages adds in code (packages/gate/src/io/config.js) before the row table. */
const BUILT_IN = ['node', 'go', 'rust', 'python', 'php', 'elixir', 'csharp', 'cmake', 'make'];

/** Toolchains for one detected entry. */
const one = (language, command = '') => languageToolchains([{ language, command }]).toolchains;

test('gate.language-toolchains.rows: clause 1: languageToolchains returns the sorted unique toolchains detected entries need, with a row for every language detectLanguages returns [C7]', () => {
  assert.deepEqual(languageToolchains([{ language: 'python', command: 'pytest' }, { language: 'go', command: 'go test ./...' }, { language: 'python', command: 'pytest' }]), { toolchains: ['go', 'python3'], unknown: [] });
  assert.deepEqual(one('rust', 'cargo test'), ['cargo']);
  assert.deepEqual(one('maven', 'mvn test'), ['java', 'mvn']);
  assert.deepEqual(one('gradle', './gradlew test'), ['java']);
  assert.deepEqual(one('gradle', 'gradle test'), ['gradle', 'java']);
  assert.deepEqual(one('ruby', 'bundle exec rspec'), ['bundle', 'ruby']);
  assert.deepEqual(one('swift', 'swift test'), ['swift']);
  assert.deepEqual(one('python', 'uv run pytest'), ['python3', 'uv']);
  assert.deepEqual(one('python', 'poetry run pytest'), ['poetry', 'python3']);
  for (const language of [...BUILT_IN, ...LANGUAGE_ROWS.map((row) => row.language)]) {
    assert.ok(TOOLCHAIN_LANGUAGES.includes(language), `${language} has a toolchain row`);
    assert.ok(one(language).length > 0, `${language} needs at least one toolchain`);
  }
});

test('gate.language-toolchains.names: clause 2: every toolchain name matches the runner probe name rule [C7]', () => {
  const commands = ['', 'uv run pytest', 'poetry run pytest', 'bundle exec rspec', 'rake test', 'gradle test', './gradlew test', 'composer test', 'flutter test', 'dart test'];
  for (const language of TOOLCHAIN_LANGUAGES) {
    for (const command of commands) {
      for (const name of one(language, command)) assert.match(name, TOOLCHAIN_NAME, `${language} '${command}' gives ${name}`);
    }
  }
  assert.equal(TOOLCHAIN_NAME.source, '^[a-z][a-z0-9+_-]{0,31}$', 'the same rule the runner probe applies');
});

test('gate.language-toolchains.unknown: clause 3: an unknown language adds no toolchain and is listed in unknown [C7]', () => {
  assert.deepEqual(languageToolchains([{ language: 'cobol', command: 'cobc -x' }]), { toolchains: [], unknown: ['cobol'] });
  assert.deepEqual(languageToolchains([{ language: 'cobol' }, { language: 'go', command: 'go test ./...' }, { language: 'constructor' }]), { toolchains: ['go'], unknown: ['cobol', 'constructor'] });
  assert.deepEqual(languageToolchains([]), { toolchains: [], unknown: [] });
  assert.deepEqual(languageToolchains(undefined), { toolchains: [], unknown: [] });
});
