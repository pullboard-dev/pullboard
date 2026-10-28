/** Build a bounded worker import closure inside the package's shipped-file manifest [C7,P3]. */
import { isBuiltin } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  dirname,
  join,
  posix,
} from 'node:path';
import { packageFiles } from './package-files.js';
import { runtimeUrls } from './runner-runtime-urls.js';
import { createRunnerModuleParser } from './runner-module-parser.js';
import {
  commonJsIn,
  importsIn,
} from './module-imports.js';
import { Refused } from './refused.js';

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
  return target;
}

/** Reuse only successful exact-source analysis inside this reader; every read validates fresh paths and bytes. */
export function runnerPackageReader(root, entry = 'src/runner-worker.js') {
  let analyses = new Map();
  return () => {
    const parser = createRunnerModuleParser();
    try {
      const current = derivePackage(root, entry, analyses, parser.parse);
      analyses = current.analyses;
      return current.runtime;
    } finally { parser.close(); }
  };
}

/** Return all actual worker dependencies plus the real manifest, with stable path-bound bytes and a fixed 1MiB ceiling. */
export function runnerPackage(root, entry = 'src/runner-worker.js') {
  return runnerPackageReader(root, entry)();
}

/** Resolve the complete closure again, retaining pure analysis only for this successful generation's exact bytes. */
function derivePackage(root, entry, previous, parse) {
  let allowed;
  let manifest;
  try {
    allowed = new Set(packageFiles(root));
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch (error) { unavailable('package.json', error.message); }
  const files = {};
  let serializedBytes = 2; // The empty JSON object includes both braces.
  const analyses = new Map();
  let pending = [entry, 'package.json'];
  while (pending.length) {
    const level = [...new Set(pending)].filter(file => !Object.hasOwn(files, file)).sort();
    pending = [];
    if (!level.length) break;
    for (const file of level) {
      if (!allowed.has(file)) unavailable(file, 'the import closure leaves package.json files');
      files[file] = readFileSync(join(root, file), 'utf8');
      const count = Object.keys(files).length;
      if (count > 4096) unavailable(file, 'the import closure exceeds its file-count bound');
      // Only own entries enter JSON; preserve the plain object's inherited-key behavior.
      if (Object.hasOwn(files, file)) serializedBytes += Buffer.byteLength(JSON.stringify(file))
        + 1 + Buffer.byteLength(JSON.stringify(files[file])) + (count > 1 ? 1 : 0);
      if (serializedBytes > 1_048_576) unavailable(file, 'the import closure exceeds the 1 MiB transfer bound');
    }
    const modules = level.filter(file => /\.[cm]?js$/u.test(file));
    const changed = modules.filter(file => previous.get(file)?.source !== files[file]);
    const sources = changed.map(file => files[file]);
    // Without either loader spelling or an identifier escape, the CommonJS probe has no candidates.
    // importsIn still compiles every changed module; potential loader text keeps the full V8 probe.
    const suspects = changed.filter(file => files[file].includes('require')
      || files[file].includes('createRequire') || files[file].includes('\\u'));
    const findings = suspects.length ? commonJsIn(suspects.map(file => files[file]), parse) : [];
    const common = new Set(suspects.filter((_file, index) => findings[index]));
    const imports = sources.length ? importsIn(sources, parse) : [];
    for (const [index, file] of changed.entries()) {
      if (common.has(file)) unavailable(file, 'an opaque CommonJS loader prevents a complete import closure');
      const runtime = runtimeUrls(sources[index], parse);
      if (runtime === null) unavailable(file, 'an opaque runtime URL prevents a complete import closure');
      analyses.set(file, Object.freeze({ source: files[file], edges: Object.freeze([...imports[index], ...runtime]) }));
    }
    for (const file of modules) {
      if (!analyses.has(file)) analyses.set(file, previous.get(file));
      for (const specifier of analyses.get(file).edges) {
        const target = dependency(file, specifier, manifest);
        if (target !== null) pending.push(target);
      }
    }
  }
  return { runtime: { entry, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) }, analyses };
}
