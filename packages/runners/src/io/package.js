import { createHash } from 'node:crypto';
/** Build a bounded worker import closure inside the package's shipped-file manifest [C7,P3]. */
import { isBuiltin } from 'node:module';
import { existsSync } from 'node:fs';
import { statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import {
  dirname,
  join,
  posix,
  resolve,
} from 'node:path';
import { packageFiles } from './package/files.js';
import { LEGACY_WORKER_ENTRY } from '../logic/entries.js';
import { WORKER_ENTRY } from '../logic/entries.js';
import { requireEdges } from '../logic/urls.js';
import { runtimeUrls } from '../logic/urls.js';
import { TOOLING_MANIFEST_NAME } from './source/scan.js';
import { createRunnerModuleParser } from './module/parser.js';
import { parseWithPaths } from './module/parser.js';
import { commonJsWithCompiler as commonJsIn } from '../../../kernel/index.js';
import { importsWithCompiler as importsIn } from '../../../kernel/index.js';
import { Refused } from '../../../kernel/index.js';

/** Files an export writes at run time; a URL to one names no shipped source. */
const RUNTIME_ONLY = new Set([TOOLING_MANIFEST_NAME]);

/** Name the exact path that cannot safely enter the trusted runtime; never expand transfer limits. */
function unavailable(file, reason) {
  throw new Refused('RUNNER_TOOLING_FILES', `runner tooling ${file}: ${reason}; repair package.json files or the worker import before retrying`);
}

/** Resolve package import conditions without executing package code or selecting a fallback dependency. */
function importTarget(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [condition, target] of Object.entries(value)) {
      if (['node', 'import', 'default'].includes(condition)) return importTarget(target);
    }
  }
  return null;
}

/** Resolve only builtins, explicit relative paths and the current package's declared imports. */
function dependency(file, specifier, manifest) {
  if (isBuiltin(specifier)) return null;
  if (specifier === '(computed)') return null; // A computed dynamic import resolves at run time, not at capture.
  let target = specifier;
  if (target.startsWith('#')) {
    const entries = Object.entries(manifest.imports ?? {});
    let value = manifest.imports?.[target];
    if (value === undefined) {
      const match = entries.filter(([key]) => key.includes('*')).sort((a, b) => b[0].indexOf('*') - a[0].indexOf('*') || b[0].length - a[0].length)
        .find(([key]) => target.startsWith(key.split('*')[0]) && target.endsWith(key.split('*')[1]));
      if (match) {
        const [prefix, suffix] = match[0].split('*');
        const selected = importTarget(match[1]);
        value = selected?.replaceAll('*', target.slice(prefix.length, target.length - suffix.length));
      }
    }
    target = importTarget(value);
    if (!target?.startsWith('./')) unavailable(file, `unresolved package import ${specifier}`);
    target = posix.normalize(target);
  } else {
    if (!target.startsWith('./') && !target.startsWith('../')) unavailable(file, `unsupported import ${specifier}`);
    target = posix.normalize(posix.join(dirname(file), target));
  }
  if (target.startsWith('../') || target.startsWith('/') || /[\\\u0000-\u001f\u007f?#]/u.test(target)) unavailable(file, `unsafe import ${specifier}`);
  // A directory URL (new URL('../..', import.meta.url)) names a folder, not a file to ship or read.
  if (target === '.' || target.endsWith('/')) return null;
  return target;
}

/** True for a path under root that is a folder; such a runtime URL is a location, not a module in the closure. */
function isFolder(root, target) {
  try { return statSync(join(root, target)).isDirectory(); } catch { return false; }
}

export { LEGACY_WORKER_ENTRY, WORKER_ENTRY };

/** The worker entry of this tree: the legacy path while it exists (0.9.3 layout), else the cell path. */
export function workerEntry(root) {
  if (existsSync(join(root, 'src/runner-worker.js'))) return 'src/runner-worker.js';
  return existsSync(join(root, LEGACY_WORKER_ENTRY)) ? LEGACY_WORKER_ENTRY : WORKER_ENTRY;
}

/** Reuse only successful exact-source analysis inside this reader; every read validates fresh paths and bytes. */
export function runnerPackageReader(root, entry = workerEntry(root), step = () => {}) {
  let analyses = new Map();
  return () => {
    const parser = createRunnerModuleParser();
    try {
      const current = derivePackage(root, entry, analyses, parser.parse, step);
      analyses = current.analyses;
      return current.runtime;
    } finally { parser.close(); }
  };
}

/**
 * Return all actual worker dependencies plus the real manifest, with stable path-bound bytes. The transfer bound applies to
 * the gzipped capsule that carries them (remoteWorkerLaunch), and the raw size is ratcheted by packages/gate/data/ceilings/worker-bundle.json (#4140).
 */
export function runnerPackage(root, entry = workerEntry(root), step = () => {}) {
  return runnerPackageReader(root, entry, step)();
}

/** Resolve the complete closure again, retaining pure analysis only for this successful generation's exact bytes; `step` names each phase as it starts. */
function derivePackage(root, entry, previous, parse, step) {
  let allowed;
  let manifest;
  try {
    step('list the package files');
    allowed = new Set(packageFiles(root));
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch (error) { unavailable('package.json', error.message); }
  const files = {};
  const analyses = new Map();
  let pending = [entry, 'package.json'];
  while (pending.length) {
    const level = [...new Set(pending)].filter(file => !Object.hasOwn(files, file)).sort();
    pending = [];
    if (!level.length) break;
    step(`read ${level.length} closure files from ${level[0]}`);
    for (const file of level) {
      if (!allowed.has(file)) unavailable(file, 'the import closure leaves package.json files');
      files[file] = readFileSync(join(root, file), 'utf8');
      const count = Object.keys(files).length;
      if (count > 4096) unavailable(file, 'the import closure exceeds its file-count bound');
    }
    const modules = level.filter(file => /\.[cm]?js$/u.test(file));
    const changed = modules.filter(file => previous.get(file)?.source !== files[file]);
    const sources = changed.map(file => files[file]);
    // Without either loader spelling or an identifier escape, the CommonJS probe has no candidates.
    // importsIn still compiles every changed module; potential loader text keeps the full V8 probe.
    step(`parse ${changed.length} changed modules`);
    const suspects = changed.filter(file => files[file].includes('require')
      || files[file].includes('createRequire') || files[file].includes('\\u'));
    const findings = suspects.length ? commonJsIn(suspects.map(file => files[file]), parseWithPaths(parse, suspects.map(file => join(root, file)))) : [];
    const common = new Set(suspects.filter((_file, index) => findings[index]));
    const imports = sources.length ? importsIn(sources, parseWithPaths(parse, changed.map(file => join(root, file)))) : [];
    for (const [index, file] of changed.entries()) {
      const loaded = common.has(file) ? requireEdges(sources[index]) : [];
      if (loaded === null) unavailable(file, 'an opaque CommonJS loader prevents a complete import closure');
      const runtime = runtimeUrls(sources[index], parseWithPaths(parse, [join(root, file)]), RUNTIME_ONLY);
      if (runtime === null) unavailable(file, 'an opaque runtime URL prevents a complete import closure');
      analyses.set(file, Object.freeze({ source: files[file], edges: Object.freeze([...imports[index], ...runtime, ...loaded]) }));
    }
    for (const file of modules) {
      if (!analyses.has(file)) analyses.set(file, previous.get(file));
      for (const specifier of analyses.get(file).edges) {
        const target = dependency(file, specifier, manifest);
        if (target !== null && !isFolder(root, target)) pending.push(target);
      }
    }
  }
  return { runtime: { entry, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) }, analyses };
}


/** The uncompressed size of the worker bundle a launch installs, as JSON of every closure file (#4140); `step` hears each phase, so a hang can be named. */
export function workerBundleBytes(root, entry = workerEntry(root), step = () => {}) {
  return Buffer.byteLength(JSON.stringify(runnerPackage(root, entry, step).files));
}

/** The gate-policy loader the runner controller loads; it and its static imports are fingerprinted for a warmed controller (#1510). */
const POLICY_ROOT = 'packages/gate/src/logic/policy.js';
let lastPolicyAnalysis = null;

/**
 * Fingerprint the gate-policy modules a warmed controller has loaded: the policy loader and every module it statically
 * imports. These bytes never enter the worker transfer payload. A module whose imports cannot be read statically (a
 * computed import) is still fingerprinted; only the walk past it stops, so one dynamic module never disables the guard.
 */
export function controllerPolicyFingerprints(root) {
  const absoluteRoot = resolve(root);
  const previous = lastPolicyAnalysis?.root === absoluteRoot ? lastPolicyAnalysis.analyses : new Map();
  const analyses = new Map();
  const allowed = new Set(packageFiles(root));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const fingerprints = new Map();
  const parser = createRunnerModuleParser();
  let bytes = 0;
  let pending = allowed.has(POLICY_ROOT) ? [POLICY_ROOT] : [];
  try {
    while (pending.length) {
      const level = [...new Set(pending)].filter(file => !fingerprints.has(file)).sort();
      pending = [];
      for (const file of level) {
        if (!allowed.has(file)) unavailable(file, 'the gate policy import leaves package.json files');
        const source = readFileSync(join(root, file));
        bytes += source.length;
        // This is a bounded local fingerprint, independent of the unchanged 1 MiB worker capsule ceiling.
        if (fingerprints.size >= 4096 || bytes > 16 * 1024 ** 2) unavailable(file, 'the local policy fingerprint exceeds its source bound');
        fingerprints.set(file, createHash('sha256').update(source).digest('hex'));
        if (!/\.[cm]?js$/u.test(file)) continue;
        const text = source.toString('utf8');
        let imports = previous.get(file)?.source === text ? previous.get(file).imports : undefined;
        if (imports === undefined) {
          try { [imports] = importsIn([text], parseWithPaths(parser.parse, [join(absoluteRoot, file)])); }
          catch { imports = null; } // computed or opaque imports end the walk at this module
        }
        analyses.set(file, { source: text, imports });
        if (imports === null) continue;
        for (const specifier of imports) {
          const target = dependency(file, specifier, manifest);
          if (target !== null) pending.push(target);
        }
      }
    }
    lastPolicyAnalysis = { root: absoluteRoot, analyses };
    return Object.freeze(Object.fromEntries([...fingerprints].sort(([a], [b]) => a.localeCompare(b))));
  } finally { parser.close(); }
}
