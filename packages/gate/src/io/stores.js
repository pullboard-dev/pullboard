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

/** The registry file, its one home: the disk report reads it through `diskStores`, and this scan judges it [CD2,C7]. */
export const STORE_REGISTRY = 'packages/gate/data/baselines/stores.json';
export const STORE_REGISTRY_URL = new URL('../../data/baselines/stores.json', import.meta.url);
export const STORE_BASELINE = 'packages/gate/data/baselines/store-homes.json';
const REGISTRY_URL = STORE_REGISTRY_URL;
const BASELINE_URL = new URL('../../data/baselines/store-homes.json', import.meta.url);
/** Shipped source: a package's or app's src tree and its root modules; tests, fixtures and data are not judged. */
const SOURCE = /^(?:apps|packages)\/[^/]+\/(?:src\/.+|[^/]+)\.[cm]?js$/u;
/** A whole string naming a store file: a bare name or a relative path ending in a store extension. */
const STORE_FILE = /^(?:[\w.-]+\/)*([\w.-]*[\w-]\.(?:jsonl|json|sqlite))$/u;
/** A template naming a store file once each `${...}` is a `*`: the name keeps a literal stem and at least one `*`. */
const TEMPLATE_FILE = /^(?:[\w.*-]+\/)*((?=[\w.*-]*\*)[\w.*-]*[\w*-]\.(?:jsonl|json|sqlite))$/u;
/** SQL that writes a table, inside a string or template. */
/** A directory store: the segment after a `'pullboard'` path part, or `pullboard/<dir>` in one literal; no extension. */
const DIR_SEGMENT = /^[a-z][a-z0-9-]*$/u;
const DIR_LITERAL = /^(?:\.git\/)?pullboard\/([a-z][a-z0-9-]*)\//u;
const TABLE_WRITE = /\b(?:INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)\b/gu;
const TABLE_CREATE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\b/gu;

/** The sections whose rows carry their own `homes` ceilings: a `dir:<name>` store lives in `dirs`, a `stem:<name>` store in `stems`. */
const GROUPED = { 'dir:': 'dirs', 'stem:': 'stems' };

/** The section and name of a grouped store (`dir:trace`, `stem:request-*.json`), or null for a file or a table. */
function groupOf(store) {
  const prefix = Object.keys(GROUPED).find(key => store.startsWith(key));
  return prefix ? { section: GROUPED[prefix], name: store.slice(prefix.length) } : null;
}

/** The registry row of a store: a grouped store lives in its own section (see GROUPED), every other in `stores`. */
export function storeRow(registry, store) {
  const group = groupOf(store);
  return group ? registry[group.section]?.[group.name] : registry.stores[store];
}

/** Whether a repo-relative path is shipped source the store check judges. */
export function isStoreSource(path) {
  return SOURCE.test(path) && !TEST_FILE.test(path);
}

/** The name a `${...}` template gives a store file once each `${...}` is a `*`: `exit-anchor-*.json`, or `*.json` when it keeps no literal word, which no registry row names. */
function templateStem(text) {
  return text.includes('${') ? TEMPLATE_FILE.exec(text.replace(/\$\{[^}]*\}/gu, '*')) : null;
}

/** The sites of a source file that name a store file by a template with no literal word (`${id}.json`): each must come from a registry const, so none may remain. */
export function stemlessSites(source, path) {
  if (!isStoreSource(path)) return [];
  return lex(source).strings.filter(string => { const name = templateStem(string.text); return name && !/[a-z]{3}/u.test(name[1].replace(/\.(?:jsonl|json|sqlite)$/u, '')); })
    .map(string => ({ path, line: lineAt(source, string.start), text: string.text }));
}

/**
 * Every store a source file names: each string that is a store file name (`board.sqlite`, `pullboard/relay.json`),
 * as `{ store: 'board.sqlite' }`, and each table its SQL writes, as `{ store: 'table:item' }`. A template with a
 * `${...}` part registers by its literal stem, each `${...}` becoming `*` (`exit-anchor-${id}.json` is `exit-anchor-*.json`). `creates` lists the tables the file declares.
 *
 * @param {string} source
 * @param {string} path - Repo-relative; only shipped source has sites.
 * @returns {{ path: string, line: number, store: string, creates?: boolean }[]} Sites in line order.
 */
export function storeSites(source, path) {
  if (!isStoreSource(path)) return [];
  const found = [];
  let before = null;
  for (const string of lex(source).strings) {
    const dir = before?.text === 'pullboard' && /^\s*,\s*$/u.test(source.slice(before.end, string.start)) && DIR_SEGMENT.test(string.text) ? string.text : DIR_LITERAL.exec(string.text)?.[1];
    before = string;
    const name = STORE_FILE.exec(string.text), stem = name ? null : templateStem(string.text);
    if (name || stem) { found.push({ path, line: lineAt(source, string.start), store: name ? name[1] : `stem:${stem[1]}` }); continue; }
    if (dir) { found.push({ path, line: lineAt(source, string.start), store: `dir:${dir}` }); continue; }
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
    if (site.creates || groupOf(site.store) || (registry.foreign ?? []).includes(site.store)) continue;
    if (storeRow(registry, site.store)?.owner === site.path) continue;
    counts[site.path] ??= {};
    counts[site.path][site.store] = (counts[site.path][site.store] ?? 0) + 1;
  }
  return counts;
}

/**
 * The files outside a folder that write a store, sorted: the registry lists them as known violations that only shrink.
 *
 * @param {{ path: string, store: string, creates?: boolean }[]} sites
 * @param {string} store
 * @param {string} folder - Repo-relative folder the store belongs to, with a trailing slash.
 * @returns {string[]}
 */
export function storeOutsideWriters(sites, store, folder) {
  return [...new Set(sites.filter(site => site.store === store && !site.creates && !site.path.startsWith(folder)).map(site => site.path))].sort();
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
    const row = storeRow(registry, site.store);
    if (!row) {
      problems.push({ path: site.path, line: site.line, text: `CD2_UNREGISTERED_STORE: ${site.store} is not in ${STORE_REGISTRY}; register it with one owner module` });
      continue;
    }
    if (site.creates || row.owner === site.path || held.has(`${site.path}\0${site.store}`)) continue;
    const key = `${site.path}\0${site.store}`;
    seen[key] = (seen[key] ?? 0) + 1;
    const ceiling = groupOf(site.store) ? row.homes?.[site.path] ?? 0 : baseline[site.path]?.[site.store] ?? 0;
    if (seen[key] > ceiling) {
      problems.push({ path: site.path, line: site.line, text: `CD2_SECOND_HOME: ${site.store} belongs to ${row.owner}; import its path or writer from there` });
    }
  }
  return problems;
}

/** Second homes of each grouped store of one section, as `{ name: { path: n } }`: its ceilings live in its row, beside the owner. */
export function storeDirHomes(sites, registry, section = 'dirs') {
  const homes = {};
  for (const site of sites) {
    const group = groupOf(site.store);
    if (group?.section !== section || registry[section]?.[group.name]?.owner === site.path) continue;
    homes[group.name] ??= {};
    homes[group.name][site.path] = (homes[group.name][site.path] ?? 0) + 1;
  }
  return homes;
}

/** Directory-store ceilings that rose against accepted main's registry: like the file baseline, they only fall. */
export function storeDirGrowth(registry, accepted) {
  const risen = [];
  for (const [prefix, section] of Object.entries(GROUPED)) {
    for (const [name, row] of Object.entries(registry[section] ?? {})) {
      if (!accepted[section]?.[name]) continue; // registered in this change: its homes are measured once
      for (const [path, count] of Object.entries(row.homes ?? {})) {
        const before = accepted[section][name].homes?.[path] ?? 0;
        if (count > before) risen.push({ path: STORE_REGISTRY, line: 1, text: `CD2_BASELINE_ROSE: ${path} ${prefix}${name} ${before} -> ${count}; the store baseline may only fall` });
      }
    }
  }
  return risen;
}

/**
 * Ceilings that rose against accepted main's baseline: the baseline may only fall. A row moved with its code from one
 * file to another is not a rise: a file's row may grow only while that store's total across all files does not
 * (coordinator ruling 17 Nov, #10242); the lane check decides who may move which rows.
 */
export function storeBaselineGrowth(current, accepted) {
  const risen = [];
  /** Each store's count summed over every file of one baseline. */
  const totals = baseline => {
    const sums = {};
    for (const stores of Object.values(baseline)) for (const [store, count] of Object.entries(stores)) sums[store] = (sums[store] ?? 0) + count;
    return sums;
  };
  const now = totals(current), was = totals(accepted);
  for (const [path, stores] of Object.entries(current)) {
    for (const [store, count] of Object.entries(stores)) {
      const before = accepted[path]?.[store] ?? 0;
      if (count > before && now[store] > (was[store] ?? 0)) risen.push({ path: STORE_BASELINE, line: 1, text: `CD2_BASELINE_ROSE: ${path} ${store} ${before} -> ${count}; the store baseline may only fall` });
    }
  }
  return risen;
}

/** An owner under a logic layer: logic holds no write, so it cannot own a writable store. */
const LOGIC_OWNER = /^(?:packages|apps)\/[^/]+\/src\/logic\//u;

/**
 * Stores whose owner the registry pins: the owner is the module that writes the store, so moving it needs the pin
 * edited beside the row, in view of the reviewer. Why: the census picked owners by name count, and the three
 * most-shared stores landed on readers (#6735).
 *
 * @param {{ stores: Record<string, { owner: string }>, pinned?: Record<string, string> }} registry
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function storeOwnerProblems(registry) {
  const pinned = Object.entries(registry.pinned ?? {}).flatMap(([store, owner]) => registry.stores[store]?.owner === owner ? []
    : [{ path: STORE_REGISTRY, line: 1, text: `CD2_STORE_OWNER: ${store} is pinned to ${owner}, not ${registry.stores[store]?.owner ?? 'no owner'}; the writer owns the store` }]);
  const inLogic = Object.entries(registry.stores ?? {}).filter(([, row]) => row.kind !== 'repo-data' && LOGIC_OWNER.test(row.owner ?? ''))
    .map(([store, row]) => ({ path: STORE_REGISTRY, line: 1, text: `CD2_STORE_OWNER: ${store} is owned by ${row.owner}, a logic file; a writable store is owned by the io module that writes it, and only a read-only repo-data file may name a logic owner` }));
  return [...pinned, ...inLogic];
}

/** A call that writes a file or a table: what an owner module must hold for the store it owns. The fs adapter names its writes rename, write and copyFile (#11968). */
const WRITE_CALL = /writeFileSync|appendFileSync|renameSync|writeFile\(|appendFile\(|createWriteStream|writeSync|DatabaseSync|INSERT|UPDATE |DELETE FROM|atomicWrite|writeJson|writeAtomic|\.rename\(|\.write\(|\.copyFile\(/u;

/**
 * Owners that write nothing: a store's owner module must hold a write call to it, unless the row is `kind: "repo-data"`
 * (a tracked data file the code only reads). The rows whose owner writes nothing today are a measured debt list that
 * only shrinks; a new row, or a listed row whose owner now writes, is refused (#6742). The static check runs it when a change edits the registry.
 *
 * @param {{ stores: Record<string, { kind: string, owner: string }>, writeOwnerDebt?: string[] }} registry
 * @param {(file: string) => string | undefined} read - A candidate file's text; an owner it cannot read is not judged.
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function storeWriteProblems(registry, read) {
  const debt = registry.writeOwnerDebt ?? [];
  const silent = Object.entries(registry.stores).filter(([, row]) => row.kind !== 'repo-data' && row.kind !== 'table' && read(row.owner) !== undefined && !WRITE_CALL.test(read(row.owner)));
  return [
    ...silent.filter(([store]) => !debt.includes(store)).map(([store, row]) => ({ path: STORE_REGISTRY, line: 1, text: `CD2_OWNER_NO_WRITE: ${store} is owned by ${row.owner}, which holds no write call; own it by the module that writes it, or mark a read-only data file kind repo-data` })),
    ...debt.filter(store => !silent.some(([name]) => name === store)).map(store => ({ path: STORE_REGISTRY, line: 1, text: `CD2_OWNER_NO_WRITE: ${store} now has a writing owner or is repo-data; remove it from writeOwnerDebt so the list only shrinks` })),
  ];
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
  const problems = [...storeGrowth(sites, registry, baseline, today), ...storeExceptionProblems(registry, files, today), ...storeOwnerProblems(registry), ...(files.includes(STORE_REGISTRY) ? storeWriteProblems(registry, file => { try { return text(file); } catch { return undefined; } }) : [])];
  if (files.includes(STORE_BASELINE) && previous(STORE_BASELINE)) problems.push(...storeBaselineGrowth(baseline, JSON.parse(previous(STORE_BASELINE))));
  if (previous(STORE_REGISTRY)) problems.push(...storeDirGrowth(registry, JSON.parse(previous(STORE_REGISTRY))));
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
  const dirs = {};
  const stems = {};
  for (const store of Object.keys(tally).sort()) {
    const [owner] = Object.entries(tally[store]).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))[0];
    if (store.startsWith('dir:')) dirs[store.slice(4)] = { kind: 'dir', owner };
    else if (store.startsWith('stem:')) stems[store.slice(5)] = { kind: store.slice(store.lastIndexOf('.') + 1), owner };
    else stores[store] = { kind: store.startsWith('table:') ? 'table' : store.slice(store.lastIndexOf('.') + 1), owner };
  }
  return { foreign, dirs, stems, stores, exceptions: [] };
}

/** The registry with each directory and stem row's `homes` set to the current second homes (rows without any carry none). */
export function withDirHomes(registry, sites) {
  const result = { ...registry };
  for (const section of Object.values(GROUPED)) {
    const homes = storeDirHomes(sites, registry, section);
    result[section] = {};
    for (const [name, row] of Object.entries(registry[section] ?? {})) {
      const { homes: _old, ...rest } = row;
      result[section][name] = homes[name] ? { ...rest, homes: homes[name] } : rest;
    }
  }
  return result;
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
    writeFileSync(REGISTRY_URL, json(withDirHomes(registry, sites)));
    writeFileSync(BASELINE_URL, json(storeHomeCounts(sites, registry)));
  } else {
    const registry = JSON.parse(readFileSync(REGISTRY_URL, 'utf8'));
    const baseline = JSON.parse(readFileSync(BASELINE_URL, 'utf8'));
    if (process.argv.includes('--ratchet')) {
      writeFileSync(BASELINE_URL, json(tightenStoreBaseline(sites, registry, baseline)));
      writeFileSync(REGISTRY_URL, json(withDirHomes(registry, sites)));
    }
    else report(storeGrowth(sites, registry, baseline, new Date().toISOString().slice(0, 10)));
  }
}

/** The shipped registry, parsed. */
export function storeRegistry() {
  return JSON.parse(readFileSync(STORE_REGISTRY_URL, 'utf8'));
}

/**
 * The names under .git/pullboard that make up each disk group: a row's `disk` group, plus the names the registry lists
 * as `disk.unlisted` (files with no row of their own, such as SQLite sidecars). Why: one registry names every store, so
 * a store added there cannot be left out of the disk report.
 *
 * @param {{ disk: { groups: string[], unlisted?: Record<string, string[]> }, stores: Record<string, { disk?: string }>, dirs?: Record<string, { disk?: string }> }} registry
 * @returns {Record<string, string[]>} Group name to top-level names; the group `other` is never listed.
 */
export function diskStoresFrom(registry) {
  const stores = Object.fromEntries(registry.disk.groups.map(group => [group, [...(registry.disk.unlisted?.[group] ?? [])]]));
  for (const rows of [registry.stores, registry.dirs ?? {}]) {
    for (const [name, row] of Object.entries(rows)) if (stores[row.disk]) stores[row.disk].push(name);
  }
  return stores;
}

/** The disk groups of the shipped registry (see diskStoresFrom). */
export function diskStores() {
  return diskStoresFrom(storeRegistry());
}
