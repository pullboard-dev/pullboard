/** Turn changed paths into the units a test selection picks: file, package (Go), crate (Rust), project (C#, Elixir) or module (Maven, Gradle) [C7]. */

/** The values gate.selectionUnit accepts; file is the default and keeps today's behaviour. */
export const SELECTION_UNITS = ['file', 'package', 'crate', 'project', 'module'];

/** The manifest file names that mark a unit directory, by unit. */
const MARKERS = {
  crate: name => name === 'Cargo.toml',
  module: name => name === 'pom.xml' || name === 'build.gradle' || name === 'build.gradle.kts',
  project: name => name === 'mix.exs' || name.endsWith('.csproj') || name.endsWith('.sln'),
};

/** A repo path without a leading ./ or a trailing slash. */
function clean(path) {
  return String(path).replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '');
}

/** The directory holding a path; the repo root is '.'. */
function directoryOf(path) {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '.' : path.slice(0, cut);
}

/** The directories that hold a marker manifest, read from the repo file list so no disk is touched. */
function markedDirectories(unit, manifests) {
  const found = new Set();
  for (const raw of manifests ?? []) {
    const path = clean(raw);
    if (MARKERS[unit](path.slice(path.lastIndexOf('/') + 1))) found.add(directoryOf(path));
  }
  return found;
}

/** The nearest directory at or above a path that holds a marker, or null. */
function nearestMarked(path, marked) {
  let dir = directoryOf(path);
  for (;;) {
    if (marked.has(dir)) return dir;
    if (dir === '.') return null;
    dir = directoryOf(dir);
  }
}

/** Manifest names whose change alters how every unit builds, so selection stops narrowing. */
const SHARED_MANIFESTS = name => ['Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'go.work', 'mix.exs', 'mix.lock', 'Directory.Build.props', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].includes(name)
  || name.endsWith('.csproj') || name.endsWith('.sln');

/** The first changed path that is a build manifest, or null; a manifest change selects the full gate [C7]. */
export function changedUnitManifest(paths) {
  for (const raw of paths ?? []) {
    const path = clean(raw);
    if (SHARED_MANIFESTS(path.slice(path.lastIndexOf('/') + 1))) return path;
  }
  return null;
}

/** A full-gate answer: no units, with the reason selection could not narrow. */
function full(reason) {
  return { units: [], full: true, reason };
}

/**
 * Map changed paths to selection units without reading disk; manifests is the repo file list.
 * A path with no unit above it, or the binary unit, returns full true with a reason, never a guess [C7].
 */
export function selectionUnits(unit, paths, manifests) {
  const changed = (paths ?? []).map(clean).filter(Boolean);
  if (unit === 'file') return { units: [...new Set(changed)].sort(), full: false, reason: null };
  if (unit === 'binary') return full('SELECTION_UNIT_BINARY: C and C++ select by test binary; declare them through affectedSuites');
  if (unit !== 'package' && unit !== 'crate' && unit !== 'project' && unit !== 'module') return full(`SELECTION_UNIT_UNKNOWN: ${String(unit)} is not one of ${SELECTION_UNITS.join(', ')}`);
  const marked = unit === 'package' ? null : markedDirectories(unit, manifests);
  const units = new Set();
  for (const path of changed) {
    const found = unit === 'package' ? directoryOf(path) : nearestMarked(path, marked);
    if (found === null) return full(`SELECTION_UNIT_NONE: ${path} has no ${unit} above it`);
    units.add(found);
  }
  return { units: [...units].sort(), full: false, reason: null };
}
