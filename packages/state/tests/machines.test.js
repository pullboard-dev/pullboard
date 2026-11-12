/** @pullboard-test-input packages/state/tests/fixtures/machines.json packages/store/src/io/submit/handoff/retry.js */
/** @pullboard-test-input docs-tree */
/** @pullboard-world-pin: every clause reads the committed source tree, packages/state/tests/fixtures/machines.json and docs/architecture.md, because the map must match this repository's own code. */
/**
 * Keep the loop's state machines in step with the code [C7]: packages/state/tests/fixtures/machines.json and the "State machines"
 * section of docs/architecture.md must name every item status, declared move, job kind and job step the code has,
 * and nothing the code lacks, so a state can't exist that the map doesn't write down.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { sep } from 'node:path';
import { test } from 'node:test';
import { MOVES } from '../index.js';
import { STATES } from '../index.js';
import { PHASES } from '../../drive/index.js';
import { FINISH_STEPS } from '../../land/index.js';

const ROOT = join(import.meta.dirname, '../../..');
const MAP = JSON.parse(readFileSync(join(ROOT, 'packages/state/tests/fixtures/machines.json'), 'utf8'));
const HEADING = '## State machines';

/**
 * The text of the architecture page's State machines section, up to the next level-two heading.
 * @returns {string}
 */
function section() {
  const lines = readFileSync(join(ROOT, 'docs', 'architecture.md'), 'utf8').split('\n');
  const start = lines.indexOf(HEADING);
  assert.ok(start >= 0, `the architecture page has a "${HEADING.slice(3)}" section`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n');
}

/**
 * Every non-test JavaScript source the loop runs, as path and text.
 *
 * Why: job kinds and steps are written all over the cells, so the scan reads them all rather than a list that drifts.
 * @returns {{ path: string, text: string }[]}
 */
function sources() {
  const found = [];
  const pending = ['apps', 'packages', 'src', 'bin'].map(folder => join(ROOT, folder)).filter(existsSync);
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'tests') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && /\.m?js$/u.test(entry.name)) found.push({ path: relative(ROOT, path).split(sep).join('/'), text: readFileSync(path, 'utf8') });
    }
  }
  return found;
}

const SOURCES = sources();
const ALL_TEXT = SOURCES.map(source => source.text).join('\n');

/**
 * The string value of an exported constant as the given source sees it: declared in that file, or in the file it
 * imports the name from.
 *
 * Why: several cells declare a constant of the same name with different values (LANDING_JOB_KIND), so the first
 * declaration anywhere is not the one a creator uses.
 * @param {string} name
 * @param {{ path: string, text: string }} from
 * @returns {string}
 */
function constant(name, from) {
  const declared = new RegExp(`export const ${name} = '([^']+)'`, 'u');
  const own = declared.exec(from.text);
  if (own) return own[1];
  const imported = new RegExp(`(?:import|export) \\{[^}]*\\b${name}\\b[^}]*\\} from '([^']+)'`, 'u').exec(from.text);
  assert.ok(imported, `${from.path} declares or imports the constant ${name}`);
  const target = relative(ROOT, join(ROOT, from.path, '..', imported[1])).split(sep).join('/');
  const source = SOURCES.find(entry => entry.path === target || entry.path === `${target}.js` || entry.path === `${target}/index.js`);
  assert.ok(source, `${from.path} imports ${name} from ${target}, which is a source file`);
  return constant(name, source);
}

/**
 * Whether the page names a value in backticks.
 * @param {string} page
 * @param {string} value
 * @returns {boolean}
 */
function named(page, value) {
  return page.includes('`' + value + '`');
}

test('every item status and declared move is in the map and the page, and every refused move is listed [C7]', () => {
  const page = section();
  assert.deepEqual(MAP.item.statuses.map(state => state.id).sort(), STATES.map(state => state.id).sort(), 'the map names exactly the declared statuses');
  for (const state of STATES) {
    assert.ok(named(page, state.id), `the page names status ${state.id}`);
    assert.equal(MAP.item.statuses.find(row => row.id === state.id).final, Boolean(state.final), `${state.id} is final in the map exactly when declared final`);
  }
  const declared = MAP.item.transitions.filter(row => row.declared);
  const key = (verb, from, to) => `${verb}:${[...from].sort().join('|')}>${to}`;
  const code = new Set(MOVES.map(move => key(move.verb, move.from, move.to)));
  const mapped = new Set(declared.map(row => key(row.verb, row.from, row.to)));
  for (const move of code) assert.ok(mapped.has(move), `the map has the declared move ${move}`);
  for (const move of mapped) assert.ok(code.has(move), `the map's declared move ${move} is in MOVES`);
  for (const row of MAP.item.transitions) assert.ok(named(page, row.verb), `the page names move ${row.verb}`);
  for (const row of MAP.item.transitions.filter(entry => !entry.declared && entry.from.length && entry.from.some(from => from !== entry.to))) {
    const covered = MOVES.some(move => move.to === row.to && row.from.every(from => move.from.includes(from)));
    assert.ok(covered, `undeclared ${row.verb} ${row.from.join('|')} > ${row.to} rides a declared edge the board file allows`);
  }
  const edges = new Set(MOVES.flatMap(move => move.from.filter(from => from !== move.to).map(from => `${from}>${move.to}`)));
  const ids = STATES.map(state => state.id);
  const refused = ids.flatMap(from => ids.filter(to => to !== from && !edges.has(`${from}>${to}`)).map(to => `${from}>${to}`)).sort();
  assert.deepEqual(MAP.item.refused.map(row => `${row.from}>${row.to}`).sort(), refused, 'the map lists exactly the status changes no move declares');
  for (const pair of refused) assert.ok(page.includes(pair.replace('>', ' → ')), `the page lists the refused change ${pair}`);
});

test('every job kind and step the code writes is in the map and the page, and every mapped one is in the code [C7]', () => {
  const page = section();
  const kinds = new Set();
  for (const source of SOURCES) {
    for (const match of source.text.matchAll(/\b(?:createJob|keyedResult|offerJob)\([^;]*?\bkind: *(?:'([^']+)'|([A-Z][A-Z0-9_]*))/gu)) kinds.add(match[1] ?? constant(match[2], source));
  }
  const mappedKinds = new Set(MAP.jobs.map(job => job.kind));
  assert.deepEqual([...mappedKinds].sort(), [...kinds].sort(), 'the map has one table per job kind the code creates');
  const states = new Set(MAP.jobs.flatMap(job => job.states));
  const steps = new Set([...PHASES, ...FINISH_STEPS]);
  for (const source of SOURCES) {
    for (const match of source.text.matchAll(/\bwriteStep\([^,()]+,[^,()]+, *(?:'([^']+)'|([A-Z][A-Z0-9_]*)\b)/gu)) steps.add(match[1] ?? constant(match[2], source));
  }
  const handoff = SOURCES.find(source => source.path === 'packages/store/src/io/submit/handoff/retry.js');
  for (const match of handoff.text.matchAll(/\bstate: '([a-z-]+)'/gu)) steps.add(match[1]);
  for (const step of steps) assert.ok(states.has(step), `the map names the job step ${step}`);
  for (const job of MAP.jobs) {
    assert.ok(named(page, job.kind), `the page has the ${job.kind} job`);
    for (const state of job.states) {
      const literal = state.startsWith('part.') ? `'part.'` : `'${state}'`;
      assert.ok(ALL_TEXT.includes(literal), `the ${job.kind} state ${state} is written somewhere in the code`);
      assert.ok(named(page, state), `the page names the ${job.kind} state ${state}`);
    }
    for (const end of job.terminal) assert.ok(job.states.includes(end), `${job.kind}'s terminal ${end} is one of its states`);
  }
});

test('every citation names a function in an existing file, and every harness exists or is NONE [C7]', () => {
  const problems = [];
  const visit = (value, where) => {
    if (typeof value === 'string') {
      const cite = /^((?:apps|packages|src|bin)\/[\w./-]+\.m?js):([A-Za-z_$][\w$]*)$/u.exec(value);
      if (cite) {
        if (!existsSync(join(ROOT, cite[1]))) problems.push(`${where}: ${cite[1]} is missing`);
        else if (!new RegExp(`(?<![\\w$])${cite[2]}(?![\\w$])`, 'u').test(readFileSync(join(ROOT, cite[1]), 'utf8'))) problems.push(`${where}: ${cite[1]} has no ${cite[2]}`);
      }
    } else if (Array.isArray(value)) value.forEach((entry, index) => visit(entry, `${where}[${index}]`));
    else if (value && typeof value === 'object') for (const [name, entry] of Object.entries(value)) if (name !== 'gaps') visit(entry, `${where}.${name}`);
  };
  visit(MAP, 'map');
  const harnesses = [...MAP.item.transitions, ...MAP.item.refused, ...MAP.item.guardOnly, ...MAP.jobs, ...MAP.processes, ...MAP.couldHappen].map(row => row.harness);
  for (const harness of harnesses) {
    assert.ok(typeof harness === 'string' && harness, 'every row names a harness or NONE');
    if (harness !== 'NONE' && !existsSync(join(ROOT, harness))) problems.push(`harness ${harness} is missing`);
  }
  assert.deepEqual(problems, []);
});

test('every next branch that can hand out a wrong state, and every job that outlives its item, names a gap the page lists [C7]', () => {
  const page = section();
  const gaps = new Set(MAP.gaps.map(gap => gap.id));
  for (const branch of MAP.next) {
    assert.ok(['fresh', 'guarded', 'advisory', 'stale', 'n/a'].includes(branch.fresh), `${branch.n} says how fresh its hand-out is`);
    if (branch.fresh === 'stale') assert.ok(gaps.has(branch.gap), `stale branch ${branch.n} names its gap`);
    for (const state of branch.handsOut) assert.ok(MAP.item.statuses.some(row => row.id === state) || state === 'lapsed claim', `${branch.n} hands out a known state ${state}`);
    assert.ok(page.includes(`| ${branch.n} |`), `the page's next table has ${branch.n}`);
  }
  for (const job of MAP.jobs) if (job.servingCheck.status === 'violated') assert.ok(gaps.has(job.servingCheck.gap), `${job.kind} violates its serving state and names its gap`);
  for (const gap of MAP.gaps) {
    assert.ok(['high', 'medium', 'low'].includes(gap.severity), `${gap.id} has a severity`);
    assert.ok(gap.files.length && gap.test && gap.criterion, `${gap.id} is a brief with files, a test and a criterion`);
    assert.ok(page.includes(gap.id), `the page lists gap ${gap.id}`);
  }
  for (const row of MAP.couldHappen) assert.ok(page.includes(row.case), `the page lists the case "${row.case}"`);
});
