/** Data-only generated-output conflict policy; never execute candidate generators during health or replay [C7,H16]. */

/** The exact tables whose declarations own their complete marked output. */
const REGIONS = {
  'docs/formats.md': ['id-pattern', 'statuses', 'tiers', 'parser-fields', 'format-versions', 'upgrade-rules',
    'board-columns', 'board-indexes', 'board-triggers', 'temp-columns', 'temp-triggers', 'events', 'snapshot-files'],
  'docs/api.md': ['api-command-shapes', 'api-refusal-shapes', 'api-http-shapes'],
};

/** The fixed output allowlist is shared by landing and its data-only conflict policy. */
export const GENERATED_DOC_PATHS = ['docs/formats.md', 'docs/api.md', 'apps/cli/src/logic/help/additions.js'];

/** Normalize only the table in each unique region, retaining every authored surrounding byte. */
function prose(path, source) {
  for (const name of REGIONS[path]) {
    const start = `<!-- ${name}:start -->`, end = `<!-- ${name}:end -->`;
    const first = source.indexOf(start), last = source.indexOf(end);
    if (first < 0 || last < first || source.indexOf(start, first + start.length) >= 0
        || source.indexOf(end, last + end.length) >= 0) return null;
    const region = source.slice(first + start.length, last);
    const table = /^\|[^\n]*(?:\n\|[^\n]*)*/mu;
    if (!table.test(region)) return null;
    source = source.slice(0, first + start.length) + region.replace(table, '<generated table>') + source.slice(last);
  }
  return source;
}

/** A whole generated leaf or unchanged prose permits regeneration; edited narrative remains a real conflict. */
export function generatedDocResolution(path, base, ours, theirs) {
  if (path === 'apps/cli/src/logic/help/additions.js') return { kind: 'generated', keys: [], source: ours };
  if (!Object.hasOwn(REGIONS, path)) return null;
  const original = prose(path, base);
  return original !== null && prose(path, ours) === original && prose(path, theirs) === original
    ? { kind: 'generated', keys: [], source: ours } : null;
}

/** Name only source-owned outputs; arbitrary documentation is never run as a generator. */
export function generatedDocCommand(path) {
  return Object.hasOwn(REGIONS, path) || path === 'apps/cli/src/logic/help/additions.js'
    ? ['docs/tools/update-docs.js', '--print', path] : null;
}
