/** @pullboard-test-input packages/state/src/io/formats/*.json */
/** Discover format documentation from source-owned declarations, never a parallel hand-maintained table [A5,C7]. */
import {
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** Read one existing numeric version without loading board writers or executing a declaration. */
function versionAt(root, source) {
  if (source?.kind === 'engines') {
    const folder = join(root, 'packages/state/src/logic/engines');
    const values = readdirSync(folder).filter(file => /^[a-z][a-z0-9-]*-engine\.js$/u.test(file))
      .flatMap(file => [...readFileSync(join(folder, file), 'utf8').matchAll(/^export const [A-Z][A-Z0-9_]*_ENGINE = (\d+|unassignedEngine\(\));$/gmu)].map(match => match[1]));
    const highest = Math.max(1, ...values.filter(value => /^\d+$/u.test(value)).map(Number));
    return highest;
  }
  if (!/^(?:src\/[a-z][a-z0-9-]*|packages\/[a-z][a-z0-9-]*\/src\/(?:core|shell|logic|io)\/(?:[a-z][a-z0-9-]*\/)*[a-z][a-z0-9-]*)\.js$/u.test(source?.file ?? '')) throw new Error('format version source must name its source module');
  const text = readFileSync(join(root, source.file), 'utf8');
  const pattern = source.kind === 'catalog' ? /^  version: (\d+),$/gmu
    : source.kind === 'constant' && /^[A-Z][A-Z0-9_]*$/u.test(source.constant ?? '')
      ? new RegExp(`^export const ${source.constant} = (\\d+);$`, 'gmu') : null;
  const matches = pattern ? [...text.matchAll(pattern)] : [];
  if (matches.length !== 1) throw new Error(`format version is not one declared constant in ${source.file}`);
  return Number(matches[0][1]);
}

/** Read strict, independently added format declarations in deterministic historical order. */
export function discoverFormats(root) {
  const files = readdirSync(join(root, 'packages/state/src/io/formats')).filter(file => file.endsWith('.json')).sort();
  const names = new Set();
  const formats = files.map(file => {
    if (!/^[a-z][a-z0-9-]*\.json$/u.test(file)) throw new Error(`invalid format declaration ${file}`);
    const entry = JSON.parse(readFileSync(join(root, 'packages/state/src/io/formats', file), 'utf8'));
    if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name.includes('`') || names.has(entry.name)
      || !Number.isSafeInteger(entry.order) || entry.order < 0
      || [entry.name, entry.source, entry.upgrade].some(value => typeof value !== 'string' || !value || /[\r\n|]/u.test(value))) {
      throw new Error(`invalid or duplicate format declaration ${file}`);
    }
    names.add(entry.name);
    const version = versionAt(root, entry.version);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error(`invalid format version in ${file}`);
    return { ...entry, version };
  });
  return formats.sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Generate the table from its actual version sources and adjacent format declarations. */
export function formatTable(root) {
  return ['| Format | Version | Version source | Upgrade rule |', '| --- | --- | --- | --- |',
    ...discoverFormats(root).map(entry => `| \`${entry.name}\` | \`${entry.version}\` | ${entry.source} | ${entry.upgrade} |`)].join('\n');
}

/** Refresh only the documented generated region, retaining every surrounding documentation byte. */
export function writeFormatTable(root) {
  const path = join(root, 'docs', 'formats.md');
  const before = readFileSync(path, 'utf8');
  const pattern = /(<!-- format-versions:start -->\n)[\s\S]*?(\n<!-- format-versions:end -->)/u;
  if (!pattern.test(before)) throw new Error('format guide needs its generated version-table markers');
  const after = before.replace(pattern, (_, start, end) => start + formatTable(root) + end);
  if (before === after) return false;
  writeFileSync(path, after);
  return true;
}
