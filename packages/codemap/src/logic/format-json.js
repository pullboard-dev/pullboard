/** Plan data formatting shared by the plan writer and the plan-shard merge [C7,CD33]. */
/**
 * Serialize plan data so each path, import and cut is one line: diffs stay per path and every committed shard
 * stays under the 500-line file aim the fileSize ratchet counts [CD33].
 */
export function formatJson(value, indent = '') {
  const inner = indent + ' ';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const compact = JSON.stringify(value);
    if (value.every(entry => entry === null || typeof entry !== 'object') ? compact.length <= 120 : value.every(entry => Array.isArray(entry)) && compact.length <= 120) return compact;
    const rows = value.map(entry => (entry !== null && typeof entry === 'object' && (Array.isArray(entry) || JSON.stringify(entry).length <= 160) ? JSON.stringify(entry) : formatJson(entry, inner)));
    return `[\n${rows.map(row => inner + row).join(',\n')}\n${indent}]`;
  }
  const keys = Object.keys(value);
  if (!keys.length) return '{}';
  return `{\n${keys.map(key => `${inner}${JSON.stringify(key)}: ${formatJson(value[key], inner)}`).join(',\n')}\n${indent}}`;
}
