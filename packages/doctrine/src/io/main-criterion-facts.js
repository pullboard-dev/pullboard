/** Committed criterion inputs are shared; person decisions and checkout edits are never cached. */
import { join } from 'node:path';
import { gitSpawnSync } from '../../../git/light.js';
import { readFileSync } from 'node:fs';
import { Refused } from '../../../kernel/index.js';
import { CONFIG_FILE } from '../../../config/index.js';
import { DOCTRINE_FILE } from '../../../config/index.js';
import { LEGACY_DOCTRINE_FILE } from '../../../config/index.js';
import { doctrineFromSource } from './main.js';
import { standardDoctrine } from './main.js';
import { mainCheckout } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { cleanGitEnvironment } from '../../../git/index.js';
import { cachedMainFact } from '../../../codemap/index.js';
import { mainFactToolIdentity } from '../../../codemap/index.js';
import { parseSpec } from '../../../spec/index.js';
import { policyAt } from '../../../sandbox/index.js';
import { trunkRef } from '../../../sandbox/index.js';

/** Validate the portable parsed row collections before taking a local cache hit. */
function validFacts(value) {
  return value?.version === 1 && typeof value.commit === 'string'
    && value.config && typeof value.config.spec === 'string' && typeof value.config.practice === 'string'
    && (value.spec?.source === null || typeof value.spec?.source === 'string')
    && typeof value.specName === 'string' && typeof value.doctrine?.name === 'string'
    && [value.spec, value.doctrine, value.doctrine.repo, value.standard].every(parsed => parsed
      && Array.isArray(parsed.rows) && Array.isArray(parsed.sections) && Array.isArray(parsed.problems)
      && parsed.rows.every(row => typeof row.id === 'string' && typeof row.text === 'string'));
}

/** Read exact immutable Git bytes, preserving missing-file semantics. */
function sourceAt(root, commit, name) {
  const result = gitSpawnSync(['--no-replace-objects', 'show', `${commit}:${name}`],
    { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/** Return accepted-main parsed inputs without advancing HEAD, index or any working file. */
export function mainCriterionFacts(root, { commit: pinned, cacheEligible } = {}) {
  const primary = mainCheckout(root);
  const retained = primary?.commit ? null : trunkRef(root);
  const resolved = !pinned && retained ? tryGit(root, ['rev-parse', '--verify', '--quiet', `${retained}^{commit}`],
    { env: cleanGitEnvironment() }) : null;
  const commit = pinned ?? primary?.commit ?? (resolved?.status === 0 ? resolved.stdout : null);
  if (!commit || sourceAt(root, commit, CONFIG_FILE) === null) return null;
  /** Parse portable inputs once for this immutable main and executing tool. */
  function derive() {
    const config = policyAt(root, commit).config;
    const source = sourceAt(root, commit, config.spec);
    let name = config.practice;
    let doctrineSource = sourceAt(root, commit, name);
    if (doctrineSource === null && [DOCTRINE_FILE, LEGACY_DOCTRINE_FILE].includes(name)) {
      const alias = name === DOCTRINE_FILE ? LEGACY_DOCTRINE_FILE : DOCTRINE_FILE;
      const alternate = sourceAt(root, commit, alias);
      if (alternate !== null) { name = alias; doctrineSource = alternate; }
    }
    return { version: 1, commit, config, specName: config.spec,
      spec: { ...parseSpec(source ?? ''), source, name: config.spec, exists: source !== null },
      doctrine: doctrineFromSource(doctrineSource, name), standard: standardDoctrine() };
  }
  // The actual higher writer supplies the canonical runtime classifier. Reads without it remain uncached.
  let eligible = false;
  try { eligible = typeof cacheEligible === 'function' && cacheEligible() === true; }
  catch { /* Unknown runtime context is never cache authority. */ }
  const tool = eligible ? mainFactToolIdentity() : null;
  const identity = [commit, tool, process.version, process.execPath];
  const facts = !tool ? derive()
    : cachedMainFact(root, 'criterion', identity, derive, validFacts);
  facts.spec.file = join(root, facts.specName);
  return facts;
}

/** Overlay only exact applied person decisions; stale checkout omissions cannot remove governing main rows. */
export function appliedMainSpec(facts, decisions, currentSource) {
  const spec = facts.spec;
  if (currentSource === spec.source) return spec;
  const rows = new Map(spec.rows.map(row => [row.id, row]));
  const current = parseSpec(currentSource ?? '');
  const lines = (currentSource ?? '').split(/\r?\n/u);
  const committed = (spec.source ?? '').split(/\r?\n/u);
  for (const record of decisions) {
    if (record.kind !== 'spec' || !record.applied || record.file !== facts.specName) continue;
    const matching = current.rows.filter(row => row.id === record.id);
    if (matching.length !== 1 || lines[matching[0].line - 1] !== record.replacement) continue;
    const previous = rows.get(record.id);
    if (previous && ![record.source, record.replacement].includes(committed[previous.line - 1])) continue;
    const parsed = parseSpec(`## Applied decisions\n${record.replacement}\n`);
    const row = parsed.rows[0];
    if (parsed.rows.length !== 1 || row.id !== record.id || row.text !== record.text
      || row.status !== (record.decision === 'approve' ? 'approved' : 'wont')) continue;
    rows.set(row.id, { ...row, section: previous?.section ?? row.section });
  }
  return { ...spec, rows: [...rows.values()] };
}

/** Retain fresh cited-row validation without letting stale or invented local rows authorize a claim. */
export function liveCriterionSpec(root, facts, item, decisions) {
  const listed = tryGit(root, ['worktree', 'list', '--porcelain', '-z'], { env: cleanGitEnvironment() });
  const first = listed.status === 0 ? listed.stdout.split('\0')[0] : '';
  const primary = first.startsWith('worktree ') ? first.slice('worktree '.length) : null;
  let source = null;
  try { if (primary) source = readFileSync(join(primary, facts.specName), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const spec = appliedMainSpec(facts, decisions, source);
  let working;
  try { working = readFileSync(join(root, facts.specName), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return spec; }
  if (working === facts.spec.source) return spec;
  const headSource = sourceAt(root, 'HEAD', facts.specName);
  const base = tryGit(root, ['merge-base', 'HEAD', facts.commit], { env: cleanGitEnvironment() });
  const ancestor = base.status === 0 ? sourceAt(root, base.stdout.trim(), facts.specName) : headSource;
  if (working === headSource && headSource === ancestor) return spec; // An unchanged old checkout is not a local amendment.
  const local = parseSpec(working);
  const baseline = parseSpec(working === headSource ? ancestor ?? '' : headSource ?? '');
  /** Compare semantics, not line numbers or unrelated edits. */
  const shape = row => row ? JSON.stringify([row.status, row.text, row.gate]) : null;
  for (const id of (item.item_spec_ids ?? '').split(',').filter(id => id && !id.startsWith('doctrine:'))) {
    const row = local.rows.find(row => row.id === id);
    const previous = baseline.rows.find(row => row.id === id);
    const governing = spec.rows.find(row => row.id === id);
    if (shape(row) !== shape(previous) && shape(row) !== shape(governing)) {
      throw new Refused('UNKNOWN_SPEC', `${id} has an uncommitted or branch-local change outside the governing main rows; restore it or apply the person's exact row decision before retrying`);
    }
  }
  return spec;
}
