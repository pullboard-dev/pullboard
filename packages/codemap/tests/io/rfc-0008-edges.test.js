/** @pullboard-test-input docs/rfcs/0008-durable-jobs-and-runner-protocol.md */
/** RFC 0008 DJ19: the durable-jobs cells keep their edge table, read from the committed cell plan [DJ19,C7]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const PLAN = new URL('../../data/plan/', import.meta.url);

/** The DJ19 table: what each named cell may import beyond the kernel and the store (a cell with no row is unconstrained). */
const TABLE = {
  land: ['receipt', 'jobs', 'pin'],
  drive: ['jobs', 'transport', 'receipt', 'pin'],
  receipt: ['pin'],
  transport: ['pin'],
  jobs: [],
  pin: [],
};
/** Cells every constrained cell may import: the kernel, the store and git, which sit below them all. */
const BASE = ['kernel', 'store', 'git'];

/** The committed cell plan as `{ name, kind, imports }` rows. */
function loadPlan() {
  return readdirSync(PLAN).filter(file => /^\d.*\.json$/u.test(file)).map(file => {
    const cell = JSON.parse(readFileSync(new URL(file, PLAN), 'utf8'));
    return { name: cell.name, kind: cell.kind, imports: (cell.imports ?? []).map(edge => edge.cell) };
  });
}

/** Every edge that breaks DJ19 in `cells`, as `from -> to: why` rows. */
function violations(cells) {
  const found = [];
  for (const { name, kind, imports } of cells) {
    for (const to of imports) {
      if (kind === 'package' && (to === 'drive' || to === 'land')) found.push(`${name} -> ${to}: no package imports drive or land`);
      if (name in TABLE && !BASE.includes(to) && !TABLE[name].includes(to)) found.push(`${name} -> ${to}: not in the DJ19 table`);
    }
  }
  return found;
}

test('codemap.rfc-0008-edges.the-jobs-drive-land-receipt: clause 1 [C7]: the jobs, drive, land, receipt, transport and pin edges in the cell plan match the DJ19 table', () => {
  const cells = loadPlan();
  for (const name of Object.keys(TABLE)) assert.ok(cells.some(cell => cell.name === name), `the plan has the ${name} cell`);
  assert.deepEqual(violations(cells), []);
});

test('codemap.rfc-0008-edges.an-edge-outside-the-table: clause 1 [C7]: an edge outside the table, or a package importing drive or land, is a violation', () => {
  assert.deepEqual(violations([{ name: 'drive', kind: 'package', imports: ['kernel', 'jobs', 'apps/lib'] }]), ['drive -> apps/lib: not in the DJ19 table']);
  assert.deepEqual(violations([{ name: 'jobs', kind: 'package', imports: ['drive'] }]), ['jobs -> drive: no package imports drive or land', 'jobs -> drive: not in the DJ19 table']);
  assert.deepEqual(violations([{ name: 'resources', kind: 'package', imports: ['land'] }]), ['resources -> land: no package imports drive or land']);
  assert.deepEqual(violations([{ name: 'receipt', kind: 'package', imports: ['kernel', 'pin'] }, { name: 'apps/cli', kind: 'app', imports: ['drive', 'land'] }]), []);
});
