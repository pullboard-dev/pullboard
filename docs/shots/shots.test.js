/**
 * The README's screenshots and timed tour recording (I11, I13) are reproducible demo artifacts,
 * and fit the size budgets so they stay useful in the README and the site.
 */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = new URL('../../', import.meta.url);
const README = readFileSync(new URL('README.md', ROOT), 'utf8');
const files = ['desktop.png', 'phone.png', 'tour.svg'];
const shots = (name) => new URL(`docs/shots/${name}`, ROOT);

/** Assert that an image is embedded in a named README section with useful alt text. */
function linkedInSection(section, file, phrases) {
  const start = README.indexOf(`## ${section}`);
  assert.notEqual(start, -1, `README has the ${section} section`);
  const next = README.indexOf('\n## ', start + 1);
  const body = README.slice(start, next < 0 ? undefined : next);
  const match = new RegExp(`!\\[([^\\]]+)\\]\\(docs/shots/${file.replace('.', '\\.')}\\)`).exec(body);
  assert.ok(match, `${file} is embedded in ${section}`);
  for (const phrase of phrases) assert.ok(match[1].toLowerCase().includes(phrase), `${file} alt text says ${phrase}`);
}

test('the README links the desktop board and timed tour with descriptive alt text [I11,I13]', () => {
  linkedInSection('See every project at once', 'desktop.png', ['open', 'claimed', 'submitted', 'accepted']);
  linkedInSection('Try it', 'tour.svg', ['submitted', 'rejected', 'fixed', 'accepted']);
});

test('the demo assets exist and stay within their size budgets [I11,I13]', () => {
  for (const name of files) assert.ok(statSync(shots(name)).size > 0, `${name} exists`);
  assert.ok(statSync(shots('desktop.png')).size < 300_000, 'desktop PNG is under 300 KB');
  assert.ok(statSync(shots('phone.png')).size < 300_000, 'phone PNG is under 300 KB');
  assert.ok(statSync(shots('tour.svg')).size < 200_000, 'tour SVG is under 200 KB');
  const tour = readFileSync(shots('tour.svg'), 'utf8');
  assert.match(tour, /<animate attributeName="opacity"/, 'tour lines appear on a timed animation');
});

test('the demo rebuild script uses a temporary repo and isolated home [I11,I13]', () => {
  const script = readFileSync(shots('demo.mjs'), 'utf8');
  assert.match(script, /mkdtemp\(join\(tmpdir\(\)/);
  assert.match(script, /PULLBOARD_HOME: home/);
  assert.match(script, /process\.execPath, \[BIN, 'init'\]/);
});
