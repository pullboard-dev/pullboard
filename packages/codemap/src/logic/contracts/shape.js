/**
 * Compare one export's actual shape with its declared shape [C7].
 * A shape is { name, params: string[], returns: string }. Returns null when they match, a mismatch finding that names
 * the export and the first difference when they do not, and a gap finding when nothing was declared for the export.
 * Why a gap is not a mismatch: an undeclared export is missing a contract, not breaking one.
 *
 * @param {{ name: string, params: string[], returns: string } | undefined} declared
 * @param {{ name: string, params: string[], returns: string }} actual
 * @returns {{ kind: 'gap' | 'mismatch', export: string, difference: string } | null}
 */
export function checkShape(declared, actual) {
  if (!declared) return { kind: 'gap', export: actual.name, difference: `export ${actual.name} has no declared shape` };
  const finding = difference => ({ kind: 'mismatch', export: declared.name, difference });
  if (declared.name !== actual.name) return finding(`name: declared ${declared.name}, actual ${actual.name}`);
  const want = declared.params.join(', ');
  const have = actual.params.join(', ');
  if (want !== have) return finding(`params: declared (${want}), actual (${have})`);
  if (declared.returns !== actual.returns) return finding(`returns: declared ${declared.returns}, actual ${actual.returns}`);
  return null;
}
