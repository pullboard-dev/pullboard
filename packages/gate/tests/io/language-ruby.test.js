/** @pullboard-test-input source-cell gate */
/** The ruby language row: the command follows what the repo holds, and a bare Gemfile adds nothing [#3707,C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { detectLanguages } from '../../src/io/config.js';
import { detectTestGlobs } from '../../src/io/config.js';
import { privateFixtureFiles } from '../fixtures/child.js';

/** Make a repo root holding the given files, removed after the test. */
function rootWith(t, files) {
  const { root, write } = privateFixtureFiles('language-ruby-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) write(name, text);
  return root;
}

test('clause 1: a Gemfile with a spec folder detects ruby with bundle exec rspec [C7]', (t) => {
  const root = rootWith(t, { 'Gemfile': "source 'https://rubygems.org'\n", 'spec/a_spec.rb': '' });
  assert.deepEqual(detectLanguages(root), [{ language: 'ruby', command: 'bundle exec rspec' }]);
  assert.deepEqual(detectTestGlobs(root), ['**/*_spec.rb']);
  const rspecFile = rootWith(t, { 'Gemfile': '', '.rspec': '--color\n' });
  assert.deepEqual(detectLanguages(rspecFile), [{ language: 'ruby', command: 'bundle exec rspec' }]);
});

test('clause 2: a Gemfile with a Rakefile and a test folder detects bundle exec rake test [C7]', (t) => {
  const root = rootWith(t, { 'Gemfile': '', 'Rakefile': '', 'test/a_test.rb': '' });
  assert.deepEqual(detectLanguages(root), [{ language: 'ruby', command: 'bundle exec rake test' }]);
  assert.deepEqual(detectTestGlobs(root), ['**/test_*.rb', '**/*_test.rb']);
});

test('clause 3: a bare Gemfile, a Rakefile without a test folder, and no Gemfile add no ruby entry [C7]', (t) => {
  assert.deepEqual(detectLanguages(rootWith(t, { 'Gemfile': '' })), []);
  assert.deepEqual(detectTestGlobs(rootWith(t, { 'Gemfile': '' })), []);
  assert.deepEqual(detectLanguages(rootWith(t, { 'Gemfile': '', 'Rakefile': '' })), []);
  assert.deepEqual(detectLanguages(rootWith(t, { 'spec/a_spec.rb': '', 'Rakefile': '', 'test/a_test.rb': '' })), []);
});

test('clause 4: rspec wins when a repo holds both a spec and a Rake test setup [C7]', (t) => {
  const root = rootWith(t, { 'Gemfile': '', 'Rakefile': '', 'spec/a_spec.rb': '', 'test/a_test.rb': '' });
  assert.deepEqual(detectLanguages(root), [{ language: 'ruby', command: 'bundle exec rspec' }]);
});
