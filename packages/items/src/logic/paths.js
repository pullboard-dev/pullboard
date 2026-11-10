/** Pure companion path validation is shared by classification and composition [V4,H16]. */
import { Refused } from "../../../kernel/light.js";

/** Refuse unsupported path inputs without reading Git or launching a process. */
function refuse(message) { throw new Refused('ITEM_PATCH', message); }

/** Accept only portable repository paths, excluding Git control directories. */
export function safeItemPatchPath(path) {
  return typeof path === 'string' && path.length <= 4096 && !/[\\\s\x00-\x1f\x7f]/.test(path)
    && !path.startsWith('/') && !path.includes(':')
    && path.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

/** Validate a deliberately bounded ordinary Git patch; all declared paths must be safe. */
export function itemPatchPaths(patch) {
  const paths = new Set();
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!match || match[1] !== match[2] || !safeItemPatchPath(match[1])) refuse('unsupported or unsafe patch path');
      paths.add(match[1]);
    }
    if (/^(?:rename |copy |similarity index |dissimilarity index )/.test(line)) refuse('rename and copy patches are unsupported');
    const mode = /^(?:old mode|new mode|new file mode|deleted file mode) (\d+)$/.exec(line);
    if (mode && !['100644', '100755'].includes(mode[1])) refuse('only regular-file patch modes are supported');
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const path = line.slice(4);
      if (path !== '/dev/null' && (!/^[ab]\//.test(path) || !safeItemPatchPath(path.slice(2)))) refuse('unsafe patch file header');
    }
  }
  if (!paths.size) refuse('patch has no supported file changes');
  return paths;
}


/** Refuse a plain intake without echoing untrusted source lines or inventing missing metadata. */
function plainPatchRefusal() {
  throw new Refused('ITEM_PATCH_FORMAT', 'plain companions need matching safe --- a/path and +++ b/path headers with complete text hunks; use an ordinary unified diff without renames or binary data');
}

/** Remove only one Git mail envelope and its out-of-hunk signature; hunk content remains exact. */
function formatPatchBody(patch) {
  if (!/^From [a-f0-9]{40,64} Mon Sep 17 00:00:00 2001\n/u.test(patch)) return patch;
  const start = patch.indexOf('\ndiff --git ');
  const envelope = start < 0 ? '' : patch.slice(0, start);
  if (start < 0 || !/^From: .+/mu.test(envelope) || !/^Subject: .+/mu.test(envelope)
      || !/^Date: .+/mu.test(envelope)) plainPatchRefusal();
  const body = patch.slice(start + 1), lines = body.split('\n');
  let before = 0, after = 0;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (before || after) {
      if (line === '\\ No newline at end of file') continue;
      if (![' ', '-', '+'].includes(line[0])) plainPatchRefusal();
      if (line[0] !== '+') before--;
      if (line[0] !== '-') after--;
      if (before < 0 || after < 0) plainPatchRefusal();
      continue;
    }
    if (line === '-- ') return lines.slice(0, n).join('\n') + '\n';
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/u.exec(line);
    if (hunk) { before = Number(hunk[1] ?? 1); after = Number(hunk[2] ?? 1); }
    if (/^From [a-f0-9]{40,64} Mon Sep 17 /u.test(line)) plainPatchRefusal();
  }
  if (before || after) plainPatchRefusal();
  return body;
}

/** Split validated native records at file boundaries, preserving every hunk and its ordering. */
export function itemPatchParts(patch) {
  const normalized = normalizeItemPatch(patch);
  itemPatchPaths(normalized);
  return normalized.split(/(?=^diff --git )/mu).filter(Boolean).map(part => ({
    paths: [...itemPatchPaths(part)], patch: part,
  }));
}

/**
 * Add only Git file headers to a complete plain unified text diff at CLI intake.
 * Native Git-format records retain their exact bytes; hunk counts distinguish content from file headers.
 */
export function normalizeItemPatch(patch) {
  if (typeof patch !== 'string' || !patch || patch.includes('\0') || Buffer.byteLength(patch, 'utf8') > 8 * 1024 * 1024) plainPatchRefusal();
  patch = formatPatchBody(patch);
  if (patch.startsWith('diff --git ')) return patch;
  const lines = patch.split('\n'), output = [];
  let cursor = 0;
  while (cursor < lines.length) {
    if (cursor === lines.length - 1 && lines[cursor] === '') { output.push(''); break; }
    const before = /^--- a\/(\S+)$/u.exec(lines[cursor]);
    const after = /^\+\+\+ b\/(\S+)$/u.exec(lines[cursor + 1] ?? '');
    if (!before || !after || before[1] !== after[1] || !safeItemPatchPath(before[1])) plainPatchRefusal();
    output.push(`diff --git a/${before[1]} b/${before[1]}`, lines[cursor++], lines[cursor++]);
    let hunks = 0;
    while (cursor < lines.length && lines[cursor].startsWith('@@ ')) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(lines[cursor]);
      if (!hunk) plainPatchRefusal();
      const positions = [hunk[1], hunk[2] ?? '1', hunk[3], hunk[4] ?? '1'].map(Number);
      if (!positions.every(Number.isSafeInteger)) plainPatchRefusal();
      let oldLines = positions[1], newLines = positions[3], content = false;
      if (oldLines === 0 && newLines === 0) plainPatchRefusal();
      output.push(lines[cursor++]); hunks += 1;
      while (oldLines || newLines) {
        const line = lines[cursor];
        if (line === '\\ No newline at end of file') {
          if (!content) plainPatchRefusal();
          content = false; output.push(line); cursor += 1; continue;
        }
        if (typeof line !== 'string' || ![' ', '-', '+'].includes(line[0])) plainPatchRefusal();
        if (line[0] !== '+') oldLines -= 1;
        if (line[0] !== '-') newLines -= 1;
        if (oldLines < 0 || newLines < 0) plainPatchRefusal();
        content = true; output.push(line); cursor += 1;
      }
      if (lines[cursor] === '\\ No newline at end of file') {
        if (!content) plainPatchRefusal();
        output.push(lines[cursor++]);
      }
    }
    if (!hunks) plainPatchRefusal();
  }
  const normalized = output.join('\n');
  if (Buffer.byteLength(normalized, 'utf8') > 8 * 1024 * 1024) plainPatchRefusal();
  return normalized;
}
