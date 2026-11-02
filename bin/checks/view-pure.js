#!/usr/bin/env node
/**
 * Source-only adapter for the view test policy: it reports view logic tests that reach impure
 * modules (child processes, node:fs, browser launchers, ambient ports) through their imports [C7].
 *
 * It compiles source and never evaluates it. The policy and the reviewed roles live in the view lane
 * (src/view/test-policy.js, src/view/test-roles.js); this file only reads them.
 *
 * Gate behavior, so the check can join the normal gate without turning it red:
 * - the roots named in bin/checks/view-pure-roots.json are enforced: any finding on one is a failure;
 * - every other finding is reported with its count and never fails. Promoting a migrated test into
 *   the list makes it enforced from then on, so the reported count can only fall.
 */
import { existsSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commonJsIn } from '../../src/module-imports.js';
import { importsIn } from '../../src/module-imports.js';
import { VIEW_RENDERER_COVERAGE } from '../../src/view/test-policy.js';
import { viewImportTarget } from '../../src/view/test-policy.js';
import { viewTestProblems } from '../../src/view/test-policy.js';
import { VIEW_TEST_ROLES } from '../../src/view/test-roles.js';
import { lex } from './scan.js';
import { report } from './scan.js';
import { walk } from './scan.js';

/** The repo-relative file that declares the enforced roots. */
export const ENFORCED_FILE = 'bin/checks/view-pure-roots.json';
const RENDERER_MODULES = /^src\/view\/(?!page-)(?:.*-(?:model|render)|activity-words|needs-panel|needs-list|roadmap-summary|roadmap-block|home|row-component|pipeline|lifecycle-chart|held-items|record-row|items-selection|segmented-control|lifecycle-diagram)\.js$/u;

/**
 * Every finding over the view test roots and their compile-only import closure.
 *
 * @param {string} root - repository root
 * @param {{ roles?: object, coverage?: object[] }} [options]
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function viewPureReport(root, { roles = VIEW_TEST_ROLES, coverage = VIEW_RENDERER_COVERAGE } = {}) {
  const canonical = realpathSync(root);
  /** Refuse a symlink or outside file rather than reading an unrelated file as a dependency. */
  const readSource = file => {
    const absolute = resolve(canonical, file), actual = realpathSync(absolute);
    if (!actual.startsWith(canonical + sep) || !lstatSync(absolute).isFile()) throw new Error('source is outside the root or is not a regular file');
    return readFileSync(absolute, 'utf8');
  };
  const roots = walk(root, /^test\/cockpit\/[^/]+\.test\.js$/u);
  const sources = new Map(), edges = new Map(), unknown = new Map();
  const pending = [...new Set([...roots.filter(file => roles[file]?.kind === 'logic'), ...coverage.flatMap(row => row.tests)])];
  while (pending.length) {
    const batch = [];
    for (const file of pending.splice(0)) {
      if (sources.has(file) || unknown.has(file)) continue;
      try { const source = readSource(file); sources.set(file, source); batch.push({ file, source }); }
      catch (error) { unknown.set(file, 'source missing or unreadable: ' + error.message); }
    }
    if (!batch.length) continue;
    let compiled, common;
    try {
      // One real compile-only parse per frontier, never one process per unrelated journey.
      common = commonJsIn(batch.map(row => row.source));
      compiled = importsIn(batch.map(row => row.source));
    } catch (error) {
      for (const { file } of batch) unknown.set(file, 'compile-only import parsing failed: ' + error.message);
      continue;
    }
    for (const [index, { file }] of batch.entries()) {
      if (/\.[cm]ts$|\.cjs$/u.test(file) || common[index]) { unknown.set(file, 'CommonJS loader'); continue; }
      edges.set(file, compiled[index]);
      for (const request of compiled[index]) {
        const target = viewImportTarget(file, request);
        if (target && !target.startsWith('node:')) pending.push(target);
      }
    }
  }
  const rendererExports = walk(root, RENDERER_MODULES).map(module => {
    let source;
    try { source = readSource(module); } catch { unknown.set(module, 'renderer source missing/outside/nonregular'); return { module, names: ['<unknown-renderer>'] }; }
    const { code } = lex(source);
    return { module, names: [...code.matchAll(/\bexport\s+(?:async\s+)?function\s+(\w+)/gu)].map(match => match[1]) };
  });
  return viewTestProblems({ sources, edges, unknown, roots, roles, coverage, rendererExports });
}

/**
 * The enforced roots declared by #1419, or a named refusal: a missing, unreadable or empty list
 * would otherwise pass every root unchecked.
 *
 * @param {string} root
 * @returns {{ roots: string[], problems: { path: string, line: number, text: string }[] }}
 */
export function enforcedRoots(root) {
  const problem = text => ({ roots: [], problems: [{ path: ENFORCED_FILE, line: 1, text }] });
  let parsed;
  try { parsed = JSON.parse(readFileSync(resolve(root, ENFORCED_FILE), 'utf8')); }
  catch (error) { return problem('enforced root list unreadable: ' + error.message); }
  const roots = parsed?.roots;
  if (!Array.isArray(roots) || !roots.length || roots.some(file => typeof file !== 'string')) return problem('enforced root list is empty or not an array of paths');
  return { roots: [...new Set(roots)].sort(), problems: [] };
}

/**
 * Split findings into failures (promoted roots and missing renderer coverage) and reported debt.
 * Fails closed: an enforced root that is absent, not declared logic, or never scanned is a failure.
 *
 * @param {string} root
 * @param {{ roles?: object, coverage?: object[], enforced?: string[] }} [options]
 * @returns {{ failures: object[], reported: object[], enforced: string[] }}
 */
export function viewPureGate(root, { roles = VIEW_TEST_ROLES, coverage = VIEW_RENDERER_COVERAGE, enforced } = {}) {
  const declared = enforced ? { roots: enforced, problems: [] } : enforcedRoots(root);
  const failures = [...declared.problems], reported = [];
  const scanned = new Set(walk(root, /^test\/cockpit\/[^/]+\.test\.js$/u));
  for (const file of declared.roots) {
    if (!scanned.has(file)) failures.push({ path: file, line: 1, text: 'enforced root is not a test/cockpit test file in this tree' });
    else if (roles[file]?.kind !== 'logic') failures.push({ path: file, line: 1, text: 'enforced root has no logic role in src/view/test-roles.js' });
  }
  const held = new Set(declared.roots);
  for (const file of scanned) if (roles[file]?.kind === 'logic' && !held.has(file)) failures.push({ path: file, line: 1, text: 'declared logic root must be promoted into ' + ENFORCED_FILE });
  for (const finding of viewPureReport(root, { roles, coverage })) (held.has(finding.path) || finding.path.startsWith('src/view/') ? failures : reported).push(finding);
  return { failures, reported, enforced: declared.roots };
}

/** Print the findings: failures as path:line: text and exit 1; the reported rest as one count line plus --report detail. */
function main(argv) {
  const detail = argv.includes('--report');
  const root = resolve(argv.find(argument => !argument.startsWith('--')) ?? '.');
  const { failures, reported, enforced } = viewPureGate(root);
  const files = new Set(reported.map(finding => finding.path));
  console.log(`view-pure: ${enforced.length} enforced root(s), ${failures.length} failure(s); ${reported.length} finding(s) in ${files.size} unmigrated file(s) reported, not failing`);
  if (detail) for (const finding of reported) console.log(`reported ${finding.path}:${finding.line}: ${finding.text}`);
  report(failures);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
