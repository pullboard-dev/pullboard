/** @pullboard-test-input docs/formats.md docs/formats/* */
/** @pullboard-world-pin reads docs/formats.md, the page map and each user page to compare their text. */
/** Each user page of the formats map exists, holds its section of docs/formats.md unchanged, and stays short [C7]. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

/** Sections of docs/formats.md by title, each as its exact text from the heading to the next, ignoring fenced code. */
function sections() {
  const out = new Map();
  let fenced = false;
  let title = null;
  for (const line of readFileSync(resolve(ROOT, 'docs/formats.md'), 'utf8').split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    if (!fenced && line.startsWith('## ')) {
      title = line.slice(3).trim();
      out.set(title, [line]);
    } else if (title) out.get(title).push(line);
  }
  return new Map([...out].map(([name, rows]) => [name, rows.join('\n').trim()]));
}

/** Whether a section is only its heading and a one-line link to its page, the form it takes once the page is its only copy. */
function isLinkOnly(section, path) {
  const rows = section.split('\n').filter((l) => l.trim() !== '');
  return rows.length === 2 && rows[1].includes(`](${path.replace('docs/', '')})`);
}

/** Whether the page holds the section: its text verbatim, or for a link-only section its heading and some body. */
function pageHoldsSection(page, title, section, path) {
  if (!isLinkOnly(section, path)) return page.includes(section);
  return page.includes(`## ${title}\n`) && page.split(`## ${title}\n`)[1].trim() !== '';
}

/** User rows of the map as { title, path }, with any planned marker dropped. */
function userPages() {
  return readFileSync(resolve(ROOT, 'docs/formats/map.md'), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('| ') && l.includes('| user |'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .map(([title, , page]) => ({ title, path: page.replace(/^\[([^\]]*)\]\([^)]*\)/u, '$1').split(' ')[0] }));
}

test('clause 1: each user page named in the map exists under docs/formats [C7]', () => {
  const pages = userPages();
  assert.ok(pages.length > 0, 'the map names user pages');
  for (const { title, path } of pages) {
    assert.match(path, /^docs\/formats\/[a-z-]+\.md$/u, title);
    assert.ok(existsSync(resolve(ROOT, path)), `${title}: ${path} exists`);
  }
});

test('clause 1: each user page holds the text of its section of docs/formats.md unchanged [C7]', () => {
  const all = sections();
  for (const { title, path } of userPages()) {
    assert.ok(all.has(title), `${title} is a section of docs/formats.md`);
    assert.ok(pageHoldsSection(readFileSync(resolve(ROOT, path), 'utf8'), title, all.get(title), path), `${path} holds the ${title} section`);
  }
});

test('clause 1: a section that is only its heading and a link to its page passes while the page holds the section [C7]', () => {
  const path = 'docs/formats/spec.md';
  const link = '## Spec\n\nMoved to [the page](formats/spec.md).';
  assert.ok(isLinkOnly(link, path));
  assert.ok(!isLinkOnly('## Spec\n\nMoved to [the page](formats/spec.md).\nMore prose.', path));
  assert.ok(!isLinkOnly('## Spec\n\nMoved to [other](formats/other.md).', path));
  assert.ok(pageHoldsSection('# Page\n\n## Spec\n\nThe prose.\n', 'Spec', link, path));
  assert.ok(!pageHoldsSection('# Page\n\nNo section.\n', 'Spec', link, path), 'a page without the section fails');
  assert.ok(!pageHoldsSection('# Page\n\n## Spec\n', 'Spec', link, path), 'a page with an empty section fails');
  assert.ok(pageHoldsSection('x\n## Spec\n\nBody\n', 'Spec', '## Spec\n\nBody', path), 'a full section still needs verbatim text');
  assert.ok(!pageHoldsSection('x\n', 'Spec', '## Spec\n\nBody', path));
});

test('clause 1: each user page is under 150 lines [C7]', () => {
  for (const { path } of userPages()) {
    const lines = readFileSync(resolve(ROOT, path), 'utf8').split('\n').length;
    assert.ok(lines < 150, `${path} has ${lines} lines`);
  }
});
