/** The layered CLI help stays short, command-specific, and in parity with its declaration [N37,I1]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { HELP, resultCommands } from '../src/cli.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const sandboxes = [];

after(() => {
  for (const folder of sandboxes) rmSync(folder, { recursive: true, force: true });
});

/** Run the real CLI in a temporary directory so help needs no initialized board. */
function run(...args) {
  const folder = mkdtempSync(join(tmpdir(), 'pullboard-help-'));
  sandboxes.push(folder);
  return spawnSync(process.execPath, [BIN, ...args], { cwd: folder, encoding: 'utf8' });
}

/** Read the flag rows between their heading and the example from one command's help. */
function flagsFrom(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('Flags:');
  const end = lines.indexOf('Example:');
  return lines.slice(start + 1, end).map((line) => line.trim()).filter((line) => line !== 'none');
}

test('bare help is a short first-run overview generated from its command groups [N37,I1]', () => {
  const bare = run();
  const helpFlag = run('--help');
  const helpCommand = run('help');
  assert.equal(bare.status, 0, bare.stderr);
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
    assert.match(result.stdout, new RegExp(`^  ${declaration.example.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'm'));
  }
  assert.equal(run('claim', '--help').stdout, run('help', 'claim').stdout);
  for (const name of resultCommands()) assert.ok(HELP.commands[name], `result command ${name} has a help declaration`);
  assert.deepEqual(HELP.commands.whoami.usages, ['pullboard whoami']);
  assert.deepEqual(HELP.commands.lanes.usages, ['pullboard lanes']);
  assert.deepEqual(HELP.commands.status.usages, ['pullboard status']);
  for (const name of ['whoami', 'lanes', 'status']) {
    const usages = run('help', name).stdout.match(/^Usage:.*$/gmu);
    assert.deepEqual(usages, [`Usage: pullboard ${name}`]);
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
