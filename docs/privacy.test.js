/** @pullboard-test-input docs/** DOCTRINE.md README.md CONTRIBUTING.md CHANGELOG.md */
/** Tracked docs never quote the project owner or name private machines, and the rule stays a draft row [W5]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('[W5] tracked docs never quote the owner or name private machines, and the rule is a draft row', () => {
  const root = join(import.meta.dirname, '..');
  const tracked = execFileSync('git', ['ls-files', 'docs', 'DOCTRINE.md', 'README.md', 'CONTRIBUTING.md', 'CHANGELOG.md'], { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter((name) => name !== 'docs/privacy.test.js' && /\.(?:md|html|mjs|js|css|svg|json)$/u.test(name));
  // This file holds the pattern itself, so it is the one tracked file the scan leaves out.
  const attribution = /\b(?:the|The) person, \d{1,2} [A-Z][a-z]{2}\b|\b(?:Studio|MacBook|MBP)\b/u;
  const quoted = tracked.filter((name) => attribution.test(readFileSync(join(root, name), 'utf8')));
  assert.deepEqual(quoted, [], `tracked docs quote the owner or name a machine: ${quoted.join(', ')}`);
  const doctrine = readFileSync(join(root, 'DOCTRINE.md'), 'utf8');
  assert.match(doctrine, /^- W5 \[draft, must\] Tracked files and commit bodies never quote the owner/mu, 'the privacy rule is a draft row awaiting the person');
});
