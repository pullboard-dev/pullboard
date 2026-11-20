/**
 * Each failing TAP case's diagnostics and the signature that tells two failures of one case apart: the one spelling the
 * controller's comparison, the pulled gate job and the main-test job share [V4,B3,C7].
 *
 * Why self-contained functions: a runner job runs in a project's main checkout, which has no Pullboard modules to import,
 * so its entry embeds FAILURE_DIAGNOSTICS_SOURCE; nothing here reads a name outside its own body but the version.
 */

/** The signature scheme; a signature made under another version never equals one made under this. */
export const MAIN_FAILURE_SIGNATURE_VERSION = 4;

/** Canonicalize recognized runtime noise while retaining assertion values and path relationships [V4,B3]. */
export function normalizedFailureDiagnostics(lines, root) {
  /** Only native temporary roots and mkdtemp-style directories lose their per-run spelling. */
  const temporaryPath = (value, alias, locations) => {
    // The runner root is `.pullboard-runner` on the minis and `pullboard-runner` on studio-host [C7].
    const prefix = /^(file:\/\/)?(?:\/.*\/\.?pullboard-runner\/(?:jobs|pull\/env)\/[^/]+\/(?:tmp|temp)\/|\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\/|\/(?:private\/)?tmp\/)/u.exec(value);
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
  };
  /** Normalize labeled Git identities, never bare hexadecimal assertion values or arbitrary ref-looking text. */
  const sourceIdentities = (value, alias) => {
    value = value.replace(/(\b(?:pinned as|ref|reference)\s+)(refs\/([\w.-]+)\/[\w./-]+)/gu,
      (whole, label, ref, namespace) => label + 'refs/' + namespace + '/' + alias('ref', ref));
    return value.replace(/(\b(?:source|short|commit|head|revision|object|HEAD is now at|submitted #\d+ at)\s*(?:[:=]\s*|\s+))([a-f\d]{40}|[a-f\d]{12})(?![\w])/giu,
      (whole, label, hash) => label + alias('sha', hash));
  };
  // Aliases are shared within one failure so distinct source identities, UUIDs, ports and fixture roots stay distinguishable.
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
    value = sourceIdentities(value, alias);
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

/**
 * Each `not ok` case of TAP output with its diagnostics: `lines` keeps deterministic fields (no timing, source location
 * or stack), `all` every field, and `signature` the digest of the version and normalized `lines`, or null when the case
 * names no error and failure type. A changed expected or actual value is a different signature for the same case.
 *
 * @param {string} output - The run's TAP output.
 * @param {string} root - The checkout the run ran in; its path reads as `<root>`.
 * @param {(text: string) => string} digest - sha256 hex of a string; the caller's crypto, so the source stays import-free.
 * @returns {{ name: string, indent: number, lines: string[], all: string[], done?: boolean, signature: string | null }[]}
 */
export function tapFailureDiagnostics(output, root, digest) {
  const rows = [];
  let active;
  let omitted = false;
  for (const line of String(output).split('\n')) {
    const start = /^(\s*)not ok\s+\d+\s+-\s+(.*)$/u.exec(line);
    // A `not ok` or `ok` line indented inside the active failure's own diagnostics is text that failure printed, such as a
    // nested run's TAP; it is part of that failure, never a second failure or the end of this one (#2064).
    const embedded = active && !active.done && line.startsWith(' '.repeat(active.indent));
    if (start && !embedded) {
      // Strip the TAP directive on the raw line, then undo Node's TAP escapes (\# and \\) so the name matches the case.
      active = { name: start[2].replace(/\s+#.*$/u, '').replace(/\\([\\#])/gu, '$1'), indent: start[1].length + 2, lines: [], all: [] };
      rows.push(active); omitted = false; continue;
    }
    if (!embedded && /^\s*ok\s+\d+/u.test(line)) { active = null; continue; }
    if (!active || !line.startsWith(' '.repeat(active.indent))) continue;
    const value = line.slice(active.indent);
    active.all.push(value);
    if (value === '...') active.done = true;
    if (/^(?:duration_ms|location|stack):/u.test(value)) { omitted = true; continue; }
    if (/^[\w-]+:/u.test(value)) omitted = false;
    if (!omitted && value !== '---' && value !== '...') active.lines.push(value);
  }
  return rows.map(row => ({ ...row,
    signature: row.lines.some(line => line.startsWith('error:')) && row.lines.some(line => line.startsWith('failureType:'))
      ? digest(JSON.stringify([MAIN_FAILURE_SIGNATURE_VERSION, normalizedFailureDiagnostics(row.lines, root)])) : null }));
}

/**
 * The signature of each named failing case, in order: one case's own when the diagnostics line up with the cases one to
 * one, else the single diagnostic of that name; null when a case has none or several. Why null: an unsigned case must
 * never match main by its name alone [V4,B3].
 *
 * @param {{ name: string }[]} cases
 * @param {{ name: string, signature: string | null }[]} diagnostics - tapFailureDiagnostics' rows.
 * @returns {(string | null)[]}
 */
export function caseSignatures(cases, diagnostics) {
  const aligned = diagnostics.length === cases.length && cases.every((row, index) => diagnostics[index].name === row.name);
  return cases.map((row, index) => {
    if (aligned) return diagnostics[index].signature ?? null;
    const named = diagnostics.filter(one => one.name === row.name);
    return named.length === 1 ? named[0].signature ?? null : null;
  });
}

/** The source a runner job's entry embeds to sign its failing cases the way the controller does. */
export const FAILURE_DIAGNOSTICS_SOURCE = [`const MAIN_FAILURE_SIGNATURE_VERSION = ${MAIN_FAILURE_SIGNATURE_VERSION};`,
  String(normalizedFailureDiagnostics), String(tapFailureDiagnostics), String(caseSignatures)].join('\n');
