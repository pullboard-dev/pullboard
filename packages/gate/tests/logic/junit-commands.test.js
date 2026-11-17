/** @pullboard-test-input source-cell gate */
/** Each detected language has a JUnit-writing gate command and a known report path [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JUNIT_LANGUAGES } from '../../src/logic/junit-commands.js';
import { junitCommand } from '../../src/logic/junit-commands.js';

const LANGUAGES = ['bun', 'cmake', 'csharp', 'deno', 'elixir', 'go', 'gradle', 'maven', 'node', 'php', 'python', 'ruby', 'rust', 'swift'];
const TOOL_FOLDERS = { gradle: 'build/test-results/test', maven: 'target/surefire-reports', rust: 'target/nextest/ci/junit.xml' };
const NEEDS = ['csharp', 'elixir', 'go', 'ruby', 'rust'];

test('gate.junit-commands.rows: clause 1: junitCommand returns command, report and needs for every detected language, the report under .pullboard/junit or the tool folder [C7]', () => {
  assert.deepEqual(JUNIT_LANGUAGES, LANGUAGES);
  for (const language of LANGUAGES) {
    const row = junitCommand(language);
    assert.ok(row, `${language} has a row`);
    assert.deepEqual(Object.keys(row).sort(), ['command', 'needs', 'report'], `${language} row shape`);
    assert.ok(typeof row.command === 'string' && row.command.trim(), `${language} command`);
    if (TOOL_FOLDERS[language]) assert.equal(row.report, TOOL_FOLDERS[language], `${language} uses its tool folder`);
    else assert.equal(row.report, `.pullboard/junit/${language}.xml`, `${language} report path`);
  }
  assert.equal(junitCommand('python').command, 'pytest --junitxml=.pullboard/junit/python.xml');
  assert.equal(junitCommand('swift').command, 'swift test --xunit-output .pullboard/junit/swift.xml');
  const copy = junitCommand('go');
  copy.command = 'changed';
  assert.notEqual(junitCommand('go').command, 'changed', 'a caller cannot change the table');
});

test('gate.junit-commands.no-guess: clause 2: make and unknown languages return null, never a guessed command [C7]', () => {
  for (const language of ['make', 'cobol', '', 'constructor', 'toString', '__proto__', null, undefined, 3]) {
    assert.equal(junitCommand(language), null, `${String(language)} has no row`);
  }
});

test('gate.junit-commands.needs: clause 3: rows that need an extra package name it, every other row has needs null [C7]', () => {
  const named = { csharp: /JunitXml\.TestLogger/u, elixir: /junit_formatter/u, go: /gotestsum/u, ruby: /rspec_junit_formatter/u, rust: /cargo-nextest/u };
  for (const language of LANGUAGES) {
    const { needs } = junitCommand(language);
    if (NEEDS.includes(language)) assert.match(needs, named[language], `${language} names its package`);
    else assert.equal(needs, null, `${language} needs nothing extra`);
  }
});
