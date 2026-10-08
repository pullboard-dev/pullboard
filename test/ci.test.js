/**
 * CI runs the gate (C7): on every push to main and every pull request, with Node 22.13 and 24, on
 * Linux always and on macOS once the repository is public, since GitHub bills macOS minutes tenfold
 * on private repositories. The workflow is read as text: the suite has no YAML parser and needs none.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = readFileSync(resolve(ROOT, '.github/workflows/gate.yml'), 'utf8');

/**
 * One job's text, from its name to the next job or the end.
 *
 * @param {string} name
 * @returns {string}
 */
function job(name) {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `the workflow has a ${name} job`);
  const rest = WORKFLOW.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test('CI runs the gate on every push and pull request, Node 22.13 and 24, on Linux and, once public, macOS [C7]', () => {
  assert.match(WORKFLOW, /\non:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n/, 'pushes to main and pull requests');
  for (const [name, system] of [['linux', 'ubuntu-latest'], ['macos', 'macos-latest']]) {
    const text = job(name);
    assert.ok(text.includes(`\n    runs-on: ${system}\n`), `${name} runs on ${system}`);
    assert.match(text, /\n {8}node: \['22\.13', '24'\]\n/, `${name} runs Node 22.13 and 24`);
    assert.match(text, /\n {10}node-version: \$\{\{ matrix\.node \}\}\n/, `${name} sets up the matrix's Node`);
    assert.match(text, /\n {10}fetch-depth: 0\n/, `${name} checks out full history, which spec check reads`);
    assert.match(text, /\n {6}- run: npm run gate\n/, `${name} runs the gate`);
  }
  assert.match(job('macos'), /\n {4}if: \$\{\{ !github\.event\.repository\.private \}\}\n/, 'macOS runs once the repository is public');
  assert.doesNotMatch(job('linux'), /\n {4}if:/, 'Linux runs every time');
});

test("the README shows the workflow's status badge [C7]", () => {
  const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
  const section = readme.search(/^## /mu);
  assert.notEqual(section, -1, 'the README has a section after its header');
  const header = readme.slice(0, section);
  const workflow = 'https://github\\.com/pullboard-dev/pullboard/actions/workflows/gate\\.yml';
  const githubBadge = 'https://github\\.com/pullboard-dev/pullboard/actions/workflows/gate\\.yml/badge\\.svg';
  const shieldsBadge = 'https://img\\.shields\\.io/github/actions/workflow/status/pullboard-dev/pullboard/gate\\.yml';
  const markdown = new RegExp(`\\[!\\[[^\\]]*\\]\\((?:${githubBadge}|${shieldsBadge}(?:\\?[^)]*)?)\\)\\]\\(${workflow}\\)`, 'u');
  const html = new RegExp(`<a\\b(?=[^>]*\\bhref="${workflow}")[^>]*>\\s*<img\\b(?=[^>]*\\balt="gate")(?=[^>]*\\bsrc="(?:${githubBadge}|${shieldsBadge}(?:\\?[^\"]*)?)")[^>]*>\\s*<\\/a>`, 'u');
  assert.ok(markdown.test(header) || html.test(header), 'the header links a GitHub or shields status badge to the gate workflow');
});
