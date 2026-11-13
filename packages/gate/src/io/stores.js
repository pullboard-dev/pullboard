#!/usr/bin/env node
/**
 * The store registry check: every state store (a board table, a `.json`, `.jsonl` or `.sqlite` file under
 * `.git/pullboard` or `~/.pullboard`) has one owner module, and only that module names its path or writes its table.
 * Existing second homes are a per-file ceiling that only falls [CD2].
 */
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { lex } from './scan.js';
import { lineAt } from './scan.js';
import { readText } from './scan.js';
import { report } from './scan.js';
import { TEST_FILE } from './scan.js';
import { walk } from './scan.js';

export const STORE_REGISTRY = 'packages/gate/data/baselines/stores.json';
export const STORE_BASELINE = 'packages/gate/data/baselines/store-homes.json';
const REGISTRY_URL = new URL('../../data/baselines/stores.json', import.meta.url);
const BASELINE_URL = new URL('../../data/baselines/store-homes.json', import.meta.url);
/** Shipped source: a package's or app's src tree and its root modules; tests, fixtures and data are not judged. */
const SOURCE = /^(?:apps|packages)\/[^/]+\/(?:src\/.+|[^/]+)\.[cm]?js$/u;
/** A whole string naming a store file: a bare name or a relative path ending in a store extension. */
const STORE_FILE = /^(?:[\w.-]+\/)*([\w.-]*[\w-]\.(?:jsonl|json|sqlite))$/u;
/** SQL that writes a table, inside a string or template. */
const TABLE_WRITE = /\b(?:INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)\b/gu;
const TABLE_CREATE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\b/gu;

/** Whether a repo-relative path is shipped source the store check judges. */
export function isStoreSource(path) {
  return SOURCE.test(path) && !TEST_FILE.test(path);
}

/**
 * Every store a source file names: each string that is a store file name (`board.sqlite`, `pullboard/relay.json`),
 * as `{ store: 'board.sqlite' }`, and each table its SQL writes, as `{ store: 'table:item' }`. A template with a
 * `${...}` part is not a literal name. `creates` lists the tables the file declares.
 *
 * @param {string} source
 * @param {string} path - Repo-relative; only shipped source has sites.
 * @returns {{ path: string, line: number, store: string, creates?: boolean }[]} Sites in line order.
 */
export function storeSites(source, path) {
  if (!isStoreSource(path)) return [];
  const found = [];
  for (const string of lex(source).strings) {
    const name = STORE_FILE.exec(string.text);
    if (name) { found.push({ path, line: lineAt(source, string.start), store: name[1] }); continue; }
    for (const match of string.text.matchAll(TABLE_WRITE)) found.push({ path, line: lineAt(source, string.start + 1 + match.index), store: `table:${match[1]}` });
    for (const match of string.text.matchAll(TABLE_CREATE)) found.push({ path, line: lineAt(source, string.start + 1 + match.index), store: `table:${match[1]}`, creates: true });
  }
  return found.sort((left, right) => left.line - right.line);
}

/** Every site in the shipped source of a checkout. */
export function storeReport(root) {
  return walk(root, SOURCE).filter(isStoreSource).flatMap(path => storeSites(readText(root, path), path));
}

/** The exact text a person answers to approve one second home until a date, in the kernel-export form. */
export function storeExceptionApprovalText(file, store, expires) {
  return `approve store exception ${file} ${store} until ${expires}`;
}

/**
 * Why an exception row does not hold: it needs the person's exact approval text and a date not yet passed.
 *
 * @param {{ file: string, store: string, expires: string, approval: string }} row
 * @param {string} today - `YYYY-MM-DD`.
 * @returns {string | null}
 */
export function storeExceptionFault(row, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(row.expires ?? '')) return 'has no expires date (YYYY-MM-DD)';
  if (row.approval !== storeExceptionApprovalText(row.file, row.store, row.expires)) return `needs the person's answer: ${storeExceptionApprovalText(row.file, row.store, row.expires)}`;
  if (row.expires < today) return `expired on ${row.expires}`;
  return null;
}

/** Second homes per file and store, as `{ path: { store: n } }`: sites outside the owner, unregistered ones included. */
export function storeHomeCounts(sites, registry) {
  const counts = {};
  for (const site of sites) {
    if (site.creates || (registry.foreign ?? []).includes(site.store)) continue;
    if (registry.stores[site.store]?.owner === site.path) continue;
    counts[site.path] ??= {};
    counts[site.path][site.store] = (counts[site.path][site.store] ?? 0) + 1;
  }
  return counts;
}

/**
 * The sites a change may not add: a store the registry lacks, or a store named outside its owner past the file's
 * ceiling, unless a held exception covers that file and store. Each problem names the next step.
 *
 * @param {{ path: string, line: number, store: string, creates?: boolean }[]} sites
 * @param {{ stores: Record<string, { owner: string }>, foreign?: string[], exceptions?: object[] }} registry
 * @param {Record<string, Record<string, number>>} baseline
 * @param {string} today - `YYYY-MM-DD`.
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function storeGrowth(sites, registry, baseline, today) {
  const held = new Set((registry.exceptions ?? []).filter(row => !storeExceptionFault(row, today)).map(row => `${row.file}\0${row.store}`));
  const seen = {};
  const problems = [];
  for (const site of sites) {
    if ((registry.foreign ?? []).includes(site.store)) continue;
    const row = registry.stores[site.store];
    if (!row) {
      problems.push({ path: site.path, line: site.line, text: `CD2_UNREGISTERED_STORE: ${site.store} is not in ${STORE_REGISTRY}; register it with one owner module` });
      continue;
    }
    if (site.creates || row.owner === site.path || held.has(`${site.path}\0${site.store}`)) continue;
    const key = `${site.path}\0${site.store}`;
    seen[key] = (seen[key] ?? 0) + 1;
    if (seen[key] > (baseline[site.path]?.[site.store] ?? 0)) {
      problems.push({ path: site.path, line: site.line, text: `CD2_SECOND_HOME: ${site.store} belongs to ${row.owner}; import its path or writer from there` });
    }
  }
  return problems;
}

/** Ceilings that rose against accepted main's baseline: the baseline may only fall. */
export function storeBaselineGrowth(current, accepted) {
  const risen = [];
  for (const [path, stores] of Object.entries(current)) {
    for (const [store, count] of Object.entries(stores)) {
      const before = accepted[path]?.[store] ?? 0;
      if (count > before) risen.push({ path: STORE_BASELINE, line: 1, text: `CD2_BASELINE_ROSE: ${path} ${store} ${before} -> ${count}; the store baseline may only fall` });
    }
  }
  return risen;
}

/** Held-exception faults for the exceptions a change touches: its own files, or every row when the registry changed. */
export function storeExceptionProblems(registry, files, today) {
  const all = files.includes(STORE_REGISTRY);
  return (registry.exceptions ?? []).filter(row => all || files.includes(row.file)).flatMap(row => {
    const fault = storeExceptionFault(row, today);
    return fault ? [{ path: STORE_REGISTRY, line: 1, text: `CD2_STORE_EXCEPTION: ${row.file} ${row.store} ${fault}` }] : [];
  });
}

/**
 * The static check over changed files, read through the gate's candidate and main readers. A checkout without the
 * registry (a project that is not this repository) has nothing to judge.
 *
 * @param {{ files: string[], sources: { file: string, source: string }[], text: (file: string) => string, previous: (file: string) => string }} context
 * @returns {string[]}
 */
export function storeRegistryCheck({ files, sources, text, previous }, today = new Date().toISOString().slice(0, 10)) {
  let registry;
  let baseline;
  try { registry = JSON.parse(text(STORE_REGISTRY)); baseline = JSON.parse(text(STORE_BASELINE)); } catch { return []; } // no registry: not this repository
  const sites = sources.flatMap(row => storeSites(row.source, row.file));
  const problems = [...storeGrowth(sites, registry, baseline, today), ...storeExceptionProblems(registry, files, today)];
  if (files.includes(STORE_BASELINE) && previous(STORE_BASELINE)) problems.push(...storeBaselineGrowth(baseline, JSON.parse(previous(STORE_BASELINE))));
  return problems.map(row => `${row.path}:${row.line}: ${row.text}`);
}

/**
 * The first registry from a census: each store's owner is the module naming it most (for a table, writing it most,
 * else declaring it), ties broken by path. Why: it makes the starting baseline as small as the tree allows.
 */
export function censusRegistry(sites, foreign) {
  const tally = {};
  for (const site of sites) {
    if (foreign.includes(site.store)) continue;
    tally[site.store] ??= {};
    tally[site.store][site.path] = (tally[site.store][site.path] ?? 0) + (site.creates ? 0.5 : 1);
  }
  const stores = {};
  for (const store of Object.keys(tally).sort()) {
    const [owner] = Object.entries(tally[store]).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))[0];
    stores[store] = { kind: store.startsWith('table:') ? 'table' : store.slice(store.lastIndexOf('.') + 1), owner };
  }
  return { foreign, stores, exceptions: [] };
}

/** The updater only lowers ceilings: it refuses before writing when any file has grown. */
export function tightenStoreBaseline(sites, registry, baseline) {
  const growth = storeGrowth(sites, registry, baseline, '0000-00-00');
  if (growth.length) throw new Error(growth.map(row => `${row.path}:${row.line}: ${row.text}`).join('\n'));
  return storeHomeCounts(sites, registry);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ?? process.cwd());
  const sites = storeReport(root);
  const json = value => JSON.stringify(value, null, 2) + '\n';
  if (process.argv.includes('--write')) { // first record only
    const registry = censusRegistry(sites, JSON.parse(readFileSync(REGISTRY_URL, 'utf8')).foreign ?? []);
    writeFileSync(REGISTRY_URL, json(registry));
    writeFileSync(BASELINE_URL, json(storeHomeCounts(sites, registry)));
  } else {
    const registry = JSON.parse(readFileSync(REGISTRY_URL, 'utf8'));
    const baseline = JSON.parse(readFileSync(BASELINE_URL, 'utf8'));
    if (process.argv.includes('--ratchet')) writeFileSync(BASELINE_URL, json(tightenStoreBaseline(sites, registry, baseline)));
    else report(storeGrowth(sites, registry, baseline, new Date().toISOString().slice(0, 10)));
  }
}
