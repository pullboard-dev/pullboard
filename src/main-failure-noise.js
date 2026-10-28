/** Canonicalize recognized runtime noise while retaining assertion values and path relationships [V4,B3]. */
export const MAIN_FAILURE_SIGNATURE_VERSION = 2;

/** Only native temporary roots and mkdtemp-style directories lose their per-run spelling. */
function temporaryPath(value, alias, locations) {
  const prefix = /^(file:\/\/)?(?:\/.*\/\.pullboard-runner\/jobs\/[^/]+\/(?:tmp|temp)\/|\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\/|\/(?:private\/)?tmp\/)/u.exec(value);
  if (!prefix) return value;
  const suffix = value.slice(prefix[0].length);
  let original = prefix[0];
  const parts = suffix.split('/').map(part => {
    original += part + '/';
    const dynamic = /^((?:pullboard|pb|fixture|node-test)[\w.-]*-)[A-Za-z0-9]{6}$/u.exec(part);
    return dynamic ? dynamic[1] + alias('directory', original) : part;
  });
  const path = (prefix[1] ?? '') + '<tmp>/' + parts.join('/');
  return locations ? path.replace(/:\d+(?::\d+)?(?=[),;]?\s*$)/u, ':<location>') : path;
}

/** Share aliases within one failure so equal and distinct UUIDs, ports and fixture directories stay distinguishable. */
export function normalizedFailureDiagnostics(lines, root) {
  const aliases = new Map();
  const counts = new Map();
  /** Number identities independently by kind and first occurrence, never merge two different runtime values. */
  const alias = (kind, value) => {
    const key = JSON.stringify([kind, value]);
    if (!aliases.has(key)) {
      const count = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, count);
      aliases.set(key, '<' + kind + ':' + count + '>');
    }
    return aliases.get(key);
  };
  let field = '';
  return lines.map(line => {
    const header = /^([\w-]+):/u.exec(line);
    if (header) field = header[1];
    const locations = field === 'error' && /^\s+(?:at\s|stderr:)/u.test(line);
    let value = line.replaceAll(root, '<root>');
    if (locations) value = value.replace(/((?:file:\/\/)?<root>\/[^:\s"'\\<>]+):\d+(?::\d+)?(?=[),;]?\s*$)/gu, '$1:<location>');
    value = value.replace(/(?:file:\/\/)?\/[^\s"'\\<>]+/gu, path => temporaryPath(path, alias, locations));
    value = value.replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/giu, id => alias('uuid', id));
    value = value.replace(/\b((?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):)(\d{1,5})\b/gu,
      (whole, host, port) => Number(port) >= 32768 && Number(port) <= 65535 ? host + alias('port', port) : whole);
    // Expected/actual numeric values and command source are assertions, not elapsed measurements.
    if (field === 'error') value = value.replace(/^(\s*(?:elapsed|duration(?:_ms|Ms)?|wall(?:Ms)?)\s*[:=]\s*)\d+(?:\.\d+)?(\s*(?:ms|milliseconds|s|seconds)?\s*)$/u, '$1<elapsed>$2');
    return value;
  });
}
