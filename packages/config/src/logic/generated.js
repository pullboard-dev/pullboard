/** A project's generated files: each names the command that makes it and the files it is made from [C7]. */

/** True for a trimmed, nonempty string. */
const text = value => typeof value === 'string' && value.trim() !== '' && value.trim() === value;

/**
 * Every problem in a `generated` setting: a list of { file, generator, inputs } declarations.
 * Why: declaring a generated file is the opt-in, so a declaration with no generator is refused, naming the field.
 *
 * @param {unknown} generated the `generated` setting, undefined when the project declares none
 * @returns {string[]}
 */
export function generatedProblems(generated) {
  if (generated === undefined) return [];
  if (!Array.isArray(generated)) return ['"generated" is a list of { "file", "generator", "inputs" } declarations, one per generated file'];
  const problems = [];
  generated.forEach((entry, index) => {
    const label = entry && typeof entry === 'object' && text(entry.file) ? `"generated" entry for ${entry.file}` : `"generated" entry ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return problems.push(`${label} is an object with "file", "generator" and "inputs"`);
    for (const key of Object.keys(entry)) if (!['file', 'generator', 'inputs'].includes(key)) problems.push(`${label} has an unknown field "${key}"; use file, generator and inputs`);
    if (!text(entry.file)) problems.push(`${label} is missing "file", the path of the generated file`);
    if (!text(entry.generator)) problems.push(`${label} is missing "generator", the command that makes the file`);
    if (!Array.isArray(entry.inputs) || entry.inputs.some(input => !text(input))) problems.push(`${label} needs "inputs", a list of the files the generator reads`);
  });
  return problems;
}

/**
 * The declared generated files a change makes stale: each declaration whose input is among the changed paths [C7].
 * Why: submit must know what to regenerate before it runs any generator, and a pure answer is cheap to prove.
 *
 * @param {{ file: string, generator: string, inputs: string[] }[] | undefined} generated the `generated` setting
 * @param {string[]} changedPaths repo-relative paths the change touches
 * @returns {{ file: string, generator: string, inputs: string[] }[]} the stale declarations, in declared order
 */
export function staleGeneratedFiles(generated, changedPaths) {
  if (!Array.isArray(generated)) return [];
  const changed = new Set(changedPaths);
  return generated.filter(entry => entry.inputs.some(input => changed.has(input)));
}
