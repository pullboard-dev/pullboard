/** @pullboard-test-input apps/cli/src/io/commands/edit.js apps/cli/src/io/entry.js apps/cli/src/logic/help.js apps/view/src/io/serve.js packages/state/index.js packages/state/src/io/machine.js */
/** Help stays page-safe and its command inventory follows its printed usages [N26]. @pullboard-world-pin: the edit help case reads edit.js itself to check every option is listed. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  relative,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { HELP } from '../../src/logic/help.js';
import { commandPhrases } from '../../src/logic/help.js';
import { HELP_SECTIONS } from '../../src/logic/help/sections.js';

const ROOT = resolve(import.meta.dirname, '../../../..');

/** Read inspectable local module edges without initializing the module under inspection. */
function localImports(source, file = '') {
  const found = new Set();
  // The clause before `from` is an import or export binding list, never free text: a string constant that holds an import
  // statement, as packages/state/src/io/engine/numbers.js does, must not read as an edge.
  const staticImport = /^\s*(?:import|export)\s+(?:(?:[\w$]+\s*,\s*)?(?:\*\s+as\s+[\w$]+|\{[^}]*\}|[\w$]+)\s+from\s+)?(['"])([^'"\n]+)\1/gmu;
  const dynamicImport = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/gu;
  for (const match of source.matchAll(staticImport)) found.add(match[2]);
  for (const match of source.matchAll(dynamicImport)) found.add(match[2]);
  // Since 0b71d48c6e packages/git/src/io/trunk/install.js writes a pre-receive hook whose generated text holds one
  // dynamic import of a computed path (the guard's folder is known only at install time); no other file may have one.
  // A source file that declares its one computed load in a literal `@pullboard-module-loads` header (liveness.js keeps its
  // stale-test sweep out of the runner worker bundle, #4140) is allowed that one import; the declared module is walked as an edge.
  const declared = /^\/\*\* @pullboard-module-loads ([^*\n]+?) \*\/$/mu.exec(source)?.[1].split(' ').filter(path => !path.includes('*')) ?? [];
  for (const path of declared) found.add(relative(dirname(file), resolve(ROOT, path)).replace(/^(?!\.)/u, './'));
  const computed = file.endsWith('packages/git/src/io/trunk/install.js') || declared.length ? 1 : 0;
  assert.equal([...source.matchAll(/\bimport\s*\(/gu)].length - [...source.matchAll(dynamicImport)].length, computed,
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
  const pending = [[resolve(ROOT, 'apps/cli/src/logic/help.js')]];
  const visited = new Set();
  while (pending.length) {
    const chain = pending.pop();
    const file = chain.at(-1);
    assert.ok(![resolve(ROOT, 'apps/cli/src/io/entry.js'), resolve(ROOT, 'apps/view/src/io/serve.js')].includes(file)
      && !file.startsWith(resolve(ROOT, 'relay') + '/'), `help reaches a forbidden dependency: ${chain.join(' -> ')}`);
    if (visited.has(file)) continue;
    visited.add(file);
    if (file.endsWith('.json')) continue;
    for (const specifier of localImports(readFileSync(file, 'utf8'), file)) pending.push([...chain, resolveLocal(file, specifier)]);
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

test('cli.journeys-help-main.help-has-no-import-path-back: help has no import path back to the CLI [N26]', () => {
  const files = helpGraph();
  assert.ok(files.has(resolve(ROOT, 'packages/state/src/io/machine.js')), 'lifecycle help stays generated from the leaf declaration');
  assert.ok(files.has(resolve(ROOT, 'package.json')), 'the version stays sourced from package metadata');
});

test('cli.journeys-help-main.view-help-names-its-fixed-loopback: view help names its fixed loopback port and explicit port 0 [N26]', async () => {
  assert.match(HELP.all, /pullboard view \[--project\] \[--port N\].*default http:\/\/127\.0\.0\.1:4890/u);
  assert.match(HELP.all, /--port 0 chooses a free port/u);
});

test('cli.journeys-help-main.command-phrases-match-help-all-longest: command phrases match help --all, longest first [N26]', async t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project();
  const all = await box.runLocal(box.repo, 'help', '--all', '--json');
  assert.equal(all.code, 0, all.err);
  const full = JSON.parse(all.out).help;
  assert.equal(full, HELP.all);
  const expected = new Set(Object.keys(HELP.commands));
  for (const line of full.split('\n').filter(line => line.startsWith('  pullboard '))) {
    for (const phrase of printedPhrases(line)) expected.add(phrase);
  }
  for (const [name, declaration] of Object.entries(HELP.commands)) {
    const result = await box.runLocal(box.repo, 'help', ...name.split(' '), '--json');
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

test('cli.journeys-help-main.help-spec-lists-every-spec-subcommand: help spec lists every spec subcommand and who runs it [N32]', async t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.sandbox();
  const result = await box.runLocal(box.dir, 'help', 'spec');
  assert.equal(result.code, 0, result.err);
  for (const command of [
    'pullboard spec --json',
    'pullboard spec check',
    'pullboard spec view',
    'pullboard spec show <id>',
    'pullboard spec unmet',
    'pullboard spec signoff <ids>',
    'pullboard spec signers add',
    'pullboard spec approve <ids>',
    'pullboard spec decline <ids>',
    'pullboard spec apply',
  ]) assert.ok(result.out.includes(`  ${command} —`), `help spec names ${command}`);
  assert.match(result.out, /spec approve <ids> — person: decide from their own terminal or Pullboard View/u);
  assert.match(result.out, /spec decline <ids> — person: decide from their own terminal or Pullboard View/u);
  assert.match(result.out, /spec apply — coordinator: apply recorded row decisions to the files/u);
});

test('cli.journeys-help-main.full-help-is-assembled-from-the: full help is assembled from the independently editable command groups [C7,N26]', async () => {
  const graph = helpGraph();
  let offset = 0;
  for (const section of HELP_SECTIONS) {
    // Lifecycle help is owned by the state package and is in the help graph.
    const owner = { lifecycle: 'packages/state/index.js' }[section.name] ?? `apps/cli/src/logic/help/${section.name}.js`;
    assert.ok(graph.has(resolve(ROOT, owner)), `${section.name} has its own declaration module`);
    assert.equal(HELP.all.slice(offset, offset + section.text.length), section.text,
      `${section.name} contributes its unchanged text in declaration order`);
    offset += section.text.length;
  }
  assert.equal(offset, HELP.all.length, 'no centralized usage text is left outside the command groups');
  for (const [group, command] of [['setup', 'view'], ['work', 'claim'], ['coordinator', 'land'], ['spec', 'spec'], ['gate', 'gate']]) {
    const declaration = HELP_SECTIONS.find(section => section.name === group);
    assert.ok(declaration.text.includes(`  pullboard ${command} `), `${command} is owned by its command group`);
    assert.ok(Object.keys(HELP.commands).some(name => name === command || name.startsWith(command + ' ')),
      `${command}'s group also supplies individual command help`);
  }
});

test('cli.journeys-help-main.help-lists-every-edit-option: clause 1: help lists every edit option [C7]', async t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const full = await box.runLocal(box.repo, 'help', '--all', '--json');
  assert.equal(full.code, 0, full.err);
  const text = JSON.parse(full.out).help;
  const editStart = text.indexOf('pullboard edit <id>');
  assert.notEqual(editStart, -1, 'help --all prints the edit usage');
  const block = text.slice(editStart, text.indexOf('pullboard escalate <id>', editStart));
  // The options come from the edit command's own source, so a new flag cannot be left out of help.
  const source = readFileSync(resolve(ROOT, 'apps/cli/src/io/commands/edit.js'), 'utf8');
  const parsed = new Set([...source.matchAll(/values(?:\.([a-z]+)|\['([a-z-]+)'\])/gu)].map(match => match[1] ?? match[2]));
  for (const name of ['brief', 'brief-file']) parsed.add(name); // briefArg reads both for edit
  if (parsed.delete('route')) parsed.add('level'); // options.js folds --level into values.route (U136)
  if (parsed.delete('review-tier')) parsed.add('review'); // edit help names --review, which options.js folds into values[review-tier] (U136)
  parsed.delete('as'); // the person flag is documented under the person's own commands
  assert.ok(parsed.has('after'), 'the parsed set includes --after');
  for (const name of parsed) assert.ok(block.includes(`--${name}`), `help --all lists edit --${name}`);
});

test('cli.journeys-help-main.help-lists-timeline-forms: clause 1: help --all lists both pullboard timeline forms [C7]', async t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project();
  const all = await box.runLocal(box.repo, 'help', '--all', '--json');
  assert.equal(all.code, 0, all.err);
  const text = JSON.parse(all.out).help;
  assert.ok(text.includes('  pullboard timeline <id> [--json]'), 'help --all lists pullboard timeline <id>');
  assert.ok(text.includes('  pullboard timeline --fleet [--since 3h] [--json]'), 'help --all lists pullboard timeline --fleet');
});

test('cli.journeys-help-main.help-says-merge-conflicts-never-count: clause 1: help says merge conflicts never count, scopes handoff to agent worktrees and names what resume --diagnostics adds [V32]', () => {
  const text = HELP_SECTIONS.map(section => section.text).join('');
  const entry = (usage, next) => text.slice(text.indexOf(usage), text.indexOf(next, text.indexOf(usage)));
  assert.ok(entry('  pullboard rigor  ', '  pullboard rigor --draft-splits').includes('merge conflicts never count'));
  assert.ok(entry('  pullboard handoff', '  pullboard resume').includes("agent worktrees only; a coordinator's hand-off is its resume card"));
  assert.ok(entry('  pullboard resume', '  pullboard badge').includes('--diagnostics adds git checks and verified-not-merged work (merges cleanly, conflicts, claimed for integration)'));
});

test('cli.journeys-help-main.every-flag-in-pullboard-help-has: every flag in pullboard help has a one-line meaning [I11]', () => {
  const bare = [];
  for (const [command, declaration] of Object.entries(HELP.commands)) {
    for (const flag of declaration.flags) {
      if (flag === '--help') continue;
      if (!/^--[a-z][a-z-]*(?: \S[^—]*)? — \S/u.test(flag)) bare.push(`${command}: ${flag}`);
    }
  }
  assert.deepEqual(bare, [], `give each flag a meaning in apps/cli/src/logic/help/flag-meanings.js:\n${bare.join('\n')}`);
});
