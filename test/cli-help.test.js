/** @pullboard-test-input source-tree */
/** @pullboard-test-loads src/cli.js src/cli-help.js src/cli-main.js src/commands/*.js */
/** The layered CLI help stays short, command-specific, and in parity with its declaration [N37,I1]. */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import { after, test } from 'node:test';
import { HELP, resultCommands } from '../src/cli.js';
import * as helpDeclaration from '../src/help.js';
import { importStyleViolations } from './import-style-helpers.js';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { laneOf } from '../src/lanes.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const sandboxes = [];

after(() => {
  for (const folder of sandboxes) rmSync(folder, { recursive: true, force: true });
});

/** Run the real CLI in a temporary directory so help needs no initialized board. */
function run(...args) {
  const folder = mkdtempSync(join(tmpdir(), 'pullboard-help-'));
  sandboxes.push(folder);
  return runFixtureChild(process.execPath, [BIN, ...args], { cwd: folder, encoding: 'utf8' });
}

/** Read the flag rows between their heading and the example from one command's help. */
function flagsFrom(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('Flags:');
  const end = lines.findIndex((line, index) => index > start && ['Subcommands:', 'Example:'].includes(line));
  return lines.slice(start + 1, end).map((line) => line.trim()).filter((line) => line !== 'none');
}

test('bare help is a short first-run overview generated from its command groups [N37,I1]', () => {
  const bare = run();
  const helpFlag = run('--help');
  const helpCommand = run('help');
  assert.equal(bare.status, 0, bare.failure ?? bare.stderr);
  assert.equal(bare.stdout, `${HELP.firstRun}\n`);
  assert.equal(helpFlag.stdout, bare.stdout);
  assert.equal(helpCommand.stdout, `${HELP.overview}\n`);
  const lines = bare.stdout.trimEnd().split('\n');
  assert.ok(lines.length <= 40, `${lines.length} lines`);
  assert.equal(lines[0], 'New here? pullboard tour, then pullboard init.');
  assert.match(lines[1], /^Pullboard is a local-first work board/);
  for (const [group, names] of HELP.groups) {
    assert.ok(lines.includes(group));
    for (const name of names) assert.ok(lines.includes(`  pullboard ${name}`), `${group} includes ${name}`);
  }
  assert.equal(HELP.groups.reduce((total, [, names]) => total + names.length, 0), 12, 'the overview picks twelve commands');
  assert.ok(lines.at(-1).includes('pullboard help <command>') && lines.at(-1).includes('pullboard help --all'));
  assert.ok(lines.includes('  pullboard next'));
  const explicit = helpCommand.stdout.trimEnd().split('\n');
  assert.match(explicit[0], /^Pullboard is a local-first work board/);
  assert.notEqual(explicit[0], 'New here? pullboard tour, then pullboard init.');
  const jsonHelp = JSON.parse(run('--json', '--help').stdout).help;
  assert.equal(jsonHelp, HELP.firstRun);
  assert.ok(jsonHelp.includes('pullboard init') && jsonHelp.includes('pullboard next'));
  assert.equal(JSON.parse(run('--json').stdout).help, HELP.firstRun);
  assert.equal(JSON.parse(run('help', '--json').stdout).help, HELP.overview);
});

test('command help forms and flags match the declaration, with a full list only on --all [N37]', () => {
  for (const [name, declaration] of Object.entries(HELP.commands)) {
    const result = run('help', ...name.split(' '));
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`^Usage: ${declaration.usages[0].replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'm'));
    assert.deepEqual(flagsFrom(result.stdout), declaration.flags, `${name} flags`);
    assert.ok(result.stdout.includes(`Example:\n${declaration.example.replace(/^/gmu, '  ')}\n`), `${name} example is shown line by line`);
  }
  assert.equal(run('claim', '--help').stdout, run('help', 'claim').stdout);
  for (const name of resultCommands()) assert.ok(HELP.commands[name], `result command ${name} has a help declaration`);
  assert.deepEqual(HELP.commands.whoami.usages, ['pullboard whoami']);
  assert.deepEqual(HELP.commands.lanes.usages, ['pullboard lanes']);
  assert.deepEqual(HELP.commands.status.usages, ['pullboard status [--all]']);
  for (const name of ['whoami', 'lanes', 'status']) {
    const usages = run('help', name).stdout.match(/^Usage:.*$/gmu);
    assert.deepEqual(usages, [`Usage: pullboard ${name}${name === 'status' ? ' [--all]' : ''}`]);
  }
  const mustHaveFlags = [
    ['spec signoff', ['--note', '--note-file <file>']],
    ['verify', ['--reason TEST_FAILURE', '--note-file <file>']],
    ['escalate', ['--note-file <file>']],
    ['spec unmet', ['--must']],
  ];
  for (const [name, expected] of mustHaveFlags) {
    const text = run('help', ...name.split(' ')).stdout;
    for (const flag of expected) assert.ok(flagsFrom(text).some((line) => line.startsWith(flag)), `${name} documents ${flag}`);
  }
  for (const name of ['spec signoff', 'spec unmet']) {
    const flags = flagsFrom(run('help', ...name.split(' ')).stdout);
    assert.ok(flags.includes('--json — prints one versioned document'), `${name} keeps generic JSON help`);
    assert.ok(flags.includes('--help'), `${name} keeps generic help`);
  }
  const showSpecFlags = flagsFrom(run('help', 'spec', 'show').stdout);
  assert.ok(showSpecFlags.includes('--json — prints one versioned document'));
  assert.ok(showSpecFlags.includes('--help'));
  assert.ok(showSpecFlags.every((flag) => !['--must', '--by', '--note', '--note-file'].some((name) => flag.startsWith(name))), 'spec show excludes neighboring action flags');
  assert.ok(flagsFrom(run('help', 'spec signoff').stdout).some((flag) => flag.includes('keeps quotes, $ and backticks intact')));
  assert.ok(flagsFrom(run('help', 'spec unmet').stdout).every((flag) => !flag.startsWith('--no-items')));
  const all = run('help', '--all');
  assert.equal(all.status, 0, all.stderr);
  assert.equal(all.stdout, `${HELP.all}\n`);
  assert.match(all.stdout, /pullboard next --verify/);
});

test('an unknown command names its closest match and where to see every command [N37]', () => {
  const result = run('cliam');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no command "cliam"; closest match is "claim"/);
  assert.match(result.stderr, /pullboard help --all/);
  assert.doesNotMatch(result.stderr, /presence heartbeat unavailable/, 'an uninitialized directory has no seat to heartbeat');
  const help = run('help', 'cliam');
  assert.equal(help.status, 2);
  assert.match(help.stderr, /closest match is "claim"/);
});

test('next help exposes explicit build intent alongside review reservations [Q1,V15,N37]', () => {
  const detail = run('help', 'next');
  assert.equal(detail.status, 0, detail.stderr);
  assert.match(detail.stdout, /^       pullboard next --build$/mu);
  assert.ok(flagsFrom(detail.stdout).some((flag) => flag.startsWith('--build')));
  assert.ok(flagsFrom(detail.stdout).some((flag) => flag.startsWith('--verify')));
  assert.equal(run('next', '--help').stdout, detail.stdout);
  const all = run('help', '--all');
  assert.match(all.stdout, /pullboard next \[--wait <minutes>\]\s+offer an eligible review when reviews pile up, otherwise claim work/u);
  assert.match(all.stdout, /pullboard next --build\s+claim a build explicitly, recording a skipped review offer/u);
});

test('help names come from the command declarations [C7,N37]', async (t) => {
  const overview = run('help');
  const all = run('help', '--all');
  assert.equal(overview.status, 0, overview.failure);
  assert.equal(all.status, 0, all.failure);
  assert.equal(overview.stdout, HELP.overview + '\n');
  assert.equal(all.stdout, HELP.all + '\n');
  const undocumented = run('help', 'milestone', 'bogus');
  assert.equal(undocumented.status, 2, 'a name the CLI does not dispatch stays refused');
  assert.equal(undocumented.stdout, '');
  assert.equal(undocumented.stderr, 'pullboard: no command "milestone bogus"; closest match is "milestone items". Run pullboard help --all for the full list.\n');
  t.diagnostic('help overview bytes ' + JSON.stringify(overview.stdout));

  const directory = resolve(import.meta.dirname, '../src');
  const config = loadConfig(resolve(directory, '..'));
  const sources = readdirSync(directory, { recursive: true })
    .filter((file) => file.endsWith('.js') && laneOf(config, `src/${file}`) === 'core')
    .map((file) => ({ file, source: readFileSync(join(directory, file), 'utf8') }));
  assert.ok(sources.length > 0, 'the core lane owns source files');
  assert.deepEqual(importStyleViolations(sources), [], 'each actual static import has one binding per line');
  const styles = [
    { file: 'same-line', source: "import { first, second as renamed } from 'module';" },
    { file: 'mixed', source: "import initial, { first } from 'module';" },
    { file: 'namespace', source: "import initial, * as space from 'module';" },
    { file: 'formatted', source: "import {\n first,\n second as renamed,\n} from 'module';" },
    { file: 'comments', source: "import /* before */ { first, /* middle */ second } from 'module';" },
    { file: 'attributes', source: "import { first, second } from 'module' with { type: 'json' };" },
    { file: 'text', source: "const text = 'import { first, second }'; const raw = `import { first, second }`; const expression = /import { first, second }/; /* import { first, second } */" },
    { file: 'quoted', source: "import { 'a,b' as first } from 'module';" },
    { file: 'line-separator', source: "import { // comment\u2028 first, second } from 'module';" },
    { file: 'paragraph-separator', source: "import // comment\u2029 { first, second } from 'module';" },
  ];
  assert.deepEqual(importStyleViolations(styles), ['same-line', 'mixed', 'namespace', 'comments', 'attributes']
    .map((file) => ({ file, line: 1, count: 2 })).concat([
      { file: 'line-separator', line: 2, count: 2 },
      { file: 'paragraph-separator', line: 2, count: 2 },
    ]));

  assert.equal(typeof helpDeclaration.buildHelp, 'function', 'help is built from declarations');
  const generated = helpDeclaration.buildHelp([...resultCommands(), 'future-command']);
  for (const name of resultCommands()) assert.ok(generated.commands[name], `${name} is derived`);
  assert.deepEqual(generated.commands['future-command']?.usages, ['pullboard future-command']);
  assert.equal(generated.overview, HELP.overview, 'a new declaration preserves the overview bytes');
  assert.equal(generated.all, HELP.all, 'a new declaration preserves the full-help bytes');

  // Help and the result-command list are built in cli-help.js, from the same registry dispatch reads.
  const original = readFileSync(join(directory, 'cli-help.js'), 'utf8');
  const registryUrl = 'data:text/javascript;base64,' + Buffer.from([
    `import { COMMANDS as actual, UNLISTED_COMMANDS } from ${JSON.stringify(pathToFileURL(join(directory, 'commands/index.js')).href)};`,
    "/** A private new command proves help follows actual dispatch declarations. */",
    "export const COMMANDS = { ...actual, 'future-command': () => ({ run: () => 0 }) };",
    'export { UNLISTED_COMMANDS };',
  ].join('\n')).toString('base64');
  const extended = original.replace(/\bfrom (['"])\.\/commands\/index\.js\1/u, 'from ' + JSON.stringify(registryUrl))
    .replace(/\bfrom (['"])(\.[^'"]+)\1/gu, (_match, _quote, path) => 'from ' + JSON.stringify(pathToFileURL(resolve(directory, path)).href));
  const privateCli = await import('data:text/javascript;base64,' + Buffer.from(extended).toString('base64'));
  assert.ok(privateCli.resultCommands().includes('future-command'));
  assert.deepEqual(privateCli.HELP.commands['future-command']?.usages, ['pullboard future-command'],
    'adding an actual command requires no edit to help.js');
  assert.equal(privateCli.HELP.overview, HELP.overview);
  assert.equal(privateCli.HELP.all, HELP.all);
});

test('init help names --blueprint [I1,N37]', () => {
  const result = run('init', '--help');
  assert.equal(result.status, 0, result.failure ?? result.stderr);
  assert.ok(flagsFrom(result.stdout).some((line) => /^--blueprint <name or file> — \S/u.test(line)),
    'init help explains the blueprint name or file flag');
  assert.match(result.stdout, /^Example:\n  pullboard init --blueprint web-app$/mu);
  assert.equal(run('help', 'init').stdout, result.stdout, 'both init help entry points share the declaration');
  assert.match(run('help', '--all').stdout, /pullboard init \[--model <name>\] \[--blueprint <name or file>\]/u);
});

test('help add example runs on a fresh board [I1,L3]', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-help-add-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(root);
  mkdirSync(bin);
  // The example is run as pasted, so `pullboard` on PATH is this checkout's CLI.
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env, HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'board-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), PATH: `${bin}:${process.env.PATH ?? ''}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key)) delete env[key];
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env, encoding: 'utf8' });
  const initialized = runFixtureChild(process.execPath, [BIN, 'init'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.failure ?? `${initialized.stdout}${initialized.stderr}`);

  const help = runFixtureChild(process.execPath, [BIN, 'help', 'add'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(help.status, 0, help.failure ?? help.stderr);
  const lines = (help.stdout.split('Example:\n', 2)[1] ?? '').trimEnd().split('\n').map((line) => line.trim());
  const laneAdd = lines.indexOf('pullboard lane add web --owns src/web');
  const add = lines.indexOf('pullboard add web "Upload page" --specs G1');
  assert.equal(laneAdd, 0, `the example starts with lane add: ${lines.join(' / ')}`);
  assert.ok(add > laneAdd, `the example adds the item after its lane: ${lines.join(' / ')}`);
  for (const line of lines) {
    const result = runFixtureChild('sh', ['-c', line], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${line}\n${result.failure ?? `${result.stdout}${result.stderr}`}`);
  }
});

test('help covers every dispatched subcommand [N2]', () => {
  // Every printed subcommand phrase is one the CLI dispatches; each must have help, and an unknown name still refuses.
  const subcommands = [...new Set([...helpDeclaration.commandPhrases(HELP).filter((phrase) => phrase.includes(' ')), ...helpDeclaration.SETTING_FORMS.map((form) => `settings ${form}`)])];
  assert.ok(subcommands.includes('milestone items') && subcommands.includes('relay devices') && subcommands.includes('spec approve'),
    'the walk covers the subcommands that were refused before');
  for (const phrase of subcommands) {
    const result = run('help', ...phrase.split(' '));
    assert.equal(result.status, 0, `help ${phrase} exits 0: ${result.stderr}`);
    assert.match(result.stdout, /^Usage: pullboard /u, `help ${phrase} prints a Usage line`);
  }
  const unknown = run('help', 'milestone', 'bogus');
  assert.equal(unknown.status, 2, 'an unknown subcommand still exits 2');
  assert.equal(unknown.stdout, '');
});

test('the settings forms the CLI dispatches have help and reach their own refusal [N2]', () => {
  // The expected forms are written out here, not read from the parser: each one must have help, and
  // each must reach its own value check in settingsCommand, which proves the dispatcher knows it (#824).
  assert.deepEqual([...helpDeclaration.SETTING_FORMS], ['gateSlots', 'browserSlots', 'gate.shortSlots', 'gate.runnersFirst', 'gate.runnerWaitMs', 'landing.pool']);
  const folder = mkdtempSync(join(tmpdir(), 'pullboard-settings-'));
  sandboxes.push(folder);
  runFixtureGit(['init', '-q'], { cwd: folder });
  const refusals = { gateSlots: '[USAGE]', browserSlots: '[BAD_BROWSER_SLOTS]', 'gate.shortSlots': '[BAD_SHORT_SLOTS]', 'gate.runnersFirst': '[BAD_MACHINE_SETTINGS]', 'gate.runnerWaitMs': '[BAD_MACHINE_SETTINGS]', 'landing.pool': '[USAGE]' };
  for (const [form, code] of Object.entries(refusals)) {
    const help = run('help', 'settings', form);
    assert.equal(help.status, 0, `help settings ${form} exits 0: ${help.stderr}`);
    assert.match(help.stdout, new RegExp(`^Usage: pullboard settings ${form.replace('.', '\\.')} `, 'u'), `help settings ${form} names its usage`);
    const refused = runFixtureChild(process.execPath, [BIN, 'settings', form, 'abc'], { cwd: folder, encoding: 'utf8' });
    assert.equal(refused.status, 1, `settings ${form} abc is refused: ${refused.stdout}`);
    assert.ok(refused.stderr.includes(code), `settings ${form} reaches its own check ${code}: ${refused.stderr}`);
  }
});

test('every command comes from its own module [C7,V4]', async () => {
  const source = resolve(import.meta.dirname, '../src');
  const registry = await import(pathToFileURL(join(source, 'commands/index.js')).href).catch(() => null);
  assert.ok(registry?.COMMANDS, 'src/commands/index.js registers the commands');
  const names = Object.keys(registry.COMMANDS);
  assert.deepEqual(names, [...names].sort(), 'the registry lists commands in name order');
  for (const name of names) {
    const module = await registry.COMMANDS[name]();
    assert.equal(typeof module.run, 'function', `src/commands/${name}.js exports run`);
  }
  const files = readdirSync(join(source, 'commands')).filter((file) => file.endsWith('.js') && file !== 'index.js').map((file) => file.slice(0, -3)).sort();
  assert.deepEqual(files, [...names].sort(), 'every module under src/commands/ is registered, and every registered command has its module');
  for (const name of [...resultCommands(), 'mcp']) assert.ok(names.includes(name), `${name} comes from its own module`);
  const cli = readFileSync(join(source, 'cli.js'), 'utf8');
  assert.doesNotMatch(cli, /function (?:setup|read|work)Commands\(/u, 'src/cli.js holds no command table');
  // Dispatch lives in cli-main.js, the entry that loads only the command in hand.
  const entry = readFileSync(join(source, 'cli-main.js'), 'utf8');
  const dispatch = entry.slice(entry.indexOf('async function runCommand('), entry.indexOf('\n}\n', entry.indexOf('async function runCommand(')));
  assert.ok(dispatch.includes('COMMANDS[command]'), 'runCommand looks the command up in the registry');
  assert.doesNotMatch(dispatch, /if \(command === '[a-z-]+'(?: && [^)]*)?\) /u, 'runCommand holds no command of its own');
  for (const file of files) {
    const text = readFileSync(join(source, 'commands', `${file}.js`), 'utf8');
    assert.equal((text.match(/^export (?:async )?function run\(/gmu) ?? []).length, 1, `${file}.js declares one run function`);
  }
});

test('each command body lives in its own module, not in src/cli.js [C7,V4]', () => {
  const source = resolve(import.meta.dirname, '../src');
  const cli = readFileSync(join(source, 'cli.js'), 'utf8');
  const bodies = {
    hook: 'hookCommand', mcp: 'mcpHere', next: 'nextHere', resume: 'resumeHere', runner: 'runnerCommand', serve: 'serveHere',
    settings: 'settingsCommand', spec: 'specCommand', submit: 'submitHere', verify: 'verifyHere', view: 'viewHere', worktree: 'worktreeFor',
  };
  const declaration = (name) => new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'mu');
  for (const [command, body] of Object.entries(bodies)) {
    assert.doesNotMatch(cli, declaration(body), `${body} no longer lives in src/cli.js`);
    const module = readFileSync(join(source, 'commands', `${command}.js`), 'utf8');
    assert.match(module, declaration(body), `src/commands/${command}.js holds the ${body} body`);
  }
  const done = readFileSync(join(source, 'commands/done.js'), 'utf8');
  assert.match(done, /from '\.\/submit\.js'/u, 'done shares the submit module rather than keeping a second body');
});
