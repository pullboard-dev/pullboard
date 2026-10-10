/** Help stays page-safe and its command inventory follows its printed usages [N26]. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';

const ROOT = resolve(import.meta.dirname, '..');

/** Read inspectable local module edges without initializing the module under inspection. */
function localImports(source) {
  const found = new Set();
  const staticImport = /^\s*(?:import|export)\s+(?:(?!['"])[^;]*?\sfrom\s+)?(['"])([^'"\n]+)\1/gmu;
  const dynamicImport = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/gu;
  for (const match of source.matchAll(staticImport)) found.add(match[2]);
  for (const match of source.matchAll(dynamicImport)) found.add(match[2]);
  assert.equal([...source.matchAll(/\bimport\s*\(/gu)].length, [...source.matchAll(dynamicImport)].length,
    'leaf dependencies use inspectable literal dynamic imports');
  return [...found].filter(specifier => specifier.startsWith('.'));
}

/** Resolve local module edges without silently dropping a dependency. */
function resolveLocal(parent, specifier) {
  const base = resolve(dirname(parent), specifier);
  const file = [base, `${base}.js`, `${base}.json`, resolve(base, 'index.js')]
    .find(candidate => existsSync(candidate) && /\.(?:js|json)$/u.test(candidate));
  assert.ok(file, `local import ${specifier} resolves`);
  return file;
}

/** Walk the source graph before any runtime import can hide a cycle behind an initialization error. */
function helpGraph() {
  const pending = [[resolve(ROOT, 'src/help.js')]];
  const visited = new Set();
  while (pending.length) {
    const chain = pending.pop();
    const file = chain.at(-1);
    assert.ok(![resolve(ROOT, 'src/cli.js'), resolve(ROOT, 'src/serve.js')].includes(file)
      && !file.startsWith(resolve(ROOT, 'relay') + '/'), `help reaches a forbidden dependency: ${chain.join(' -> ')}`);
    if (visited.has(file)) continue;
    visited.add(file);
    if (file.endsWith('.json')) continue;
    for (const specifier of localImports(readFileSync(file, 'utf8'))) pending.push([...chain, resolveLocal(file, specifier)]);
  }
  return visited;
}

/** Expand a printed usage through text substitutions, independently of the production token walker. */
function printedPhrases(usage) {
  const row = usage.trim().replace(/^pullboard\s+/u, '').split(/\s{2,}/u, 1)[0];
  const siblings = row.split(/\s+\|\s+/u);
  const literal = siblings[0].match(/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*/u)?.[0] ?? '';
  const common = literal.includes(' ') ? literal.slice(0, literal.lastIndexOf(' ')) + ' ' : '';
  const variants = siblings.map((sibling, index) => /^pullboard\s/u.test(sibling)
    ? sibling.replace(/^pullboard\s+/u, '') : (index ? common : '') + sibling);
  const expanded = [];
  while (variants.length) {
    const value = variants.pop();
    const optional = /\[([a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)+(?:\s+<[^>]+>)?)\]/u.exec(value);
    if (optional) {
      variants.push(value.replace(optional[0], ''), ...optional[1].split('|').map(choice => value.replace(optional[0], choice)));
      continue;
    }
    const choices = /\b[a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)+\b/u.exec(value);
    if (choices) {
      variants.push(...choices[0].split('|').map(choice => value.replace(choices[0], choice)));
      continue;
    }
    const command = value.match(/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*(?=\s|$)/u)?.[0];
    if (command) expanded.push(command);
  }
  return expanded;
}

test('help has no import path back to the CLI [N26]', () => {
  const files = helpGraph();
  assert.ok(files.has(resolve(ROOT, 'src/machine.js')), 'lifecycle help stays generated from the leaf declaration');
  assert.ok(files.has(resolve(ROOT, 'package.json')), 'the version stays sourced from package metadata');
});

test('command phrases match help --all, longest first [N26]', async t => {
  const { HELP, commandPhrases } = await import('../src/help.js');
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project();
  const all = box.run(box.repo, 'help', '--all', '--json');
  assert.equal(all.code, 0, all.err);
  const full = JSON.parse(all.out).help;
  assert.equal(full, HELP.all);
  const expected = new Set(Object.keys(HELP.commands));
  for (const line of full.split('\n').filter(line => line.startsWith('  pullboard '))) {
    for (const phrase of printedPhrases(line)) expected.add(phrase);
  }
  for (const [name, declaration] of Object.entries(HELP.commands)) {
    const result = box.run(box.repo, 'help', ...name.split(' '), '--json');
    assert.equal(result.code, 0, `${name}: ${result.err}`);
    const usages = JSON.parse(result.out).help.split('\n').filter(line => /^(?:Usage: |\s+)pullboard /u.test(line))
      .filter(line => !line.startsWith('  pullboard ')).map(line => line.replace(/^Usage: /u, '').trim());
    assert.deepEqual(usages, declaration.usages, `${name} actual printed usages`);
    for (const usage of usages) for (const phrase of printedPhrases(usage)) expected.add(phrase);
  }
  assert.deepEqual(commandPhrases(), [...expected].sort((a, b) => b.length - a.length || a.localeCompare(b)),
    'the unique inventory equals actual full help and every printed usage, longest first');

  const cases = [
    ['pullboard up|down', ['up', 'down']],
    ['pullboard custom begin|finish <id>', ['custom begin', 'custom finish']],
    ['pullboard route [open|close <id>]', ['route', 'route open', 'route close']],
    ['pullboard group open | close <id>', ['group open', 'group close']],
    ['pullboard route group open | close <id>', ['route group open', 'route group close']],
    ['pullboard alpha | pullboard beta', ['alpha', 'beta']],
    ['pullboard flag --mode start|stop', ['flag']],
  ];
  for (const [usage, phrases] of cases) {
    const copy = { all: '  ' + usage, commands: {} };
    assert.deepEqual([...commandPhrases(copy)].sort(), [...phrases].sort(), usage);
  }
  const copy = { ...HELP, all: HELP.all + '\n  pullboard fresh branch <id>  only in copied full help',
    commands: { ...HELP.commands,
      'new alias': { usages: ['pullboard novel usage deep <id>'], flags: [], example: 'pullboard novel usage deep 1' },
      'new': { usages: ['pullboard new'], flags: [], example: 'pullboard new' },
    } };
  const added = commandPhrases(copy);
  for (const phrase of ['fresh branch', 'novel usage deep', 'new alias']) assert.ok(added.includes(phrase), `copied help adds ${phrase}`);
  for (const phrase of added) for (const prefix of added) {
    if (phrase.startsWith(prefix + ' ')) assert.ok(added.indexOf(phrase) < added.indexOf(prefix), `${phrase} precedes ${prefix}`);
  }
  assert.equal(new Set(added).size, added.length, 'each phrase occurs once');
});
