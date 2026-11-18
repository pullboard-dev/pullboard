/** @pullboard-test-input apps/view/src/** */
/** @pullboard-world-pin reads every apps/view source and stylesheet file to prove the view holds no inline style and no hand-typed colour, corner, border or shadow. */
/** The view sets no inline style, and every colour, corner, border and shadow in its CSS is a token [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const source = fileURLToPath(new URL('../../src/', import.meta.url));

/** Every file under a folder whose name ends with one of the endings. */
function files(folder, endings) {
  return readdirSync(folder).flatMap(name => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? files(path, endings) : endings.some(ending => name.endsWith(ending)) ? [path] : [];
  });
}

const SITE = /(?<![\w$.])style\s*=\s*["'\\]|\.style\.(?:setProperty|removeProperty|cssText)\b|\.style\.[\w$]+\s*=(?!=)|\.style\s*=(?!=)|setAttribute\(\s*['"]style['"]/gu;

test('view.x-io-no-inline-style.apps-view-source-has-no-style-attribute: apps/view source has no style attribute and no element style write; runtime geometry is one stylesheet keyed by data attributes [N26]', () => {
  const found = [];
  for (const path of files(source, ['.js'])) {
    readFileSync(path, 'utf8').split('\n').forEach((text, index) => {
      if (/^\s*(?:\/\/|\/?\*)/u.test(text)) return;
      if (SITE.test(text)) found.push(`${path.slice(source.length)}:${index + 1}`);
      SITE.lastIndex = 0;
    });
  }
  assert.deepEqual(found, [], 'no inline style anywhere in the view source');
  const connect = readFileSync(join(source, 'io/page/connect.js'), 'utf8');
  assert.equal(connect.match(/function geometry\(/gu).length, 1, 'one shared runtime stylesheet writer');
  assert.match(connect, /adoptedStyleSheets/u, 'the runtime sheet is built through the style API, which the page policy allows');
  for (const [path, key] of [['io/page/render.js', 'items-chain'], ['logic/cockpit/project-menu.js', 'project-menu'], ['io/cockpit/roadmap.js', 'roadmap-target']]) {
    const text = readFileSync(join(source, path), 'utf8');
    assert.ok(text.includes(`dataset.geo = '${key}'`) && text.includes(`geometry('${key}'`), `${path} places ${key} through the runtime stylesheet`);
  }
  assert.match(readFileSync(join(source, 'io/page/actions.js'), 'utf8'), /className = 'copy-field'/u, 'the hidden copy field is a class');
});

/** Declarations of every rule outside custom-property definitions, comments removed. */
function declarations(css) {
  const plain = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  return [...plain.matchAll(/(?<![-\w])([a-z][a-z-]*)\s*:\s*([^;{}]+)(?=[;}])/gu)].map(([, property, value]) => [property, value.replace(/\s*!important\s*$/u, '').replace(/\s+/gu, ' ').trim()]);
}

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/u;

test('view.x-io-no-inline-style.every-colour-corner-border-and-shadow-in: every colour, corner, border and shadow in apps/view CSS is a token, never a literal value [N26]', () => {
  const found = [];
  for (const path of files(source, ['.css'])) {
    for (const [property, value] of declarations(readFileSync(path, 'utf8'))) {
      const at = `${path.slice(source.length)}: ${property}: ${value}`;
      if (/^border(?:-(?:top|bottom|left|right|start|end|inline|block)){0,2}-radius$/u.test(property)) {
        if (!value.split(' ').every(part => part === '0' || part.startsWith('var(--radius-'))) found.push(at);
      } else if (property === 'box-shadow') {
        if (!(value === 'none' || /^var\(--[\w-]+\)$/u.test(value))) found.push(at);
      } else if (/^border(?:-(?:top|bottom|left|right|inline|block)(?:-(?:start|end))?)?$/u.test(property)) {
        if (!(['0', 'none', 'inherit'].includes(value) || /^var\(--border[\w-]*\)$/u.test(value))) found.push(at);
      } else if (['background', 'background-color', 'color', 'fill', 'stroke', 'border-color', 'outline', 'outline-color'].includes(property) || /^border-[a-z-]+-color$/u.test(property)) {
        if (COLOUR.test(value)) found.push(at);
      }
    }
  }
  assert.deepEqual(found, [], 'only tokens: a colour, corner, border or shadow typed by hand belongs in the :root token block');
});
