/** Parse the concrete handoff a capable seat gives a light builder [C7]. */
import { Refused } from '../../../kernel/index.js';

/** Require exact relative paths, a change and a proving test case, without reading replica-local files. */
export function parseDiagnosis(text) {
  const match = /^(?:Diagnosis:\s*)?Files:\s*([\s\S]+?)\s+Change:\s*([\s\S]+?)\s+Test(?: case)?:\s*([\s\S]+)$/iu.exec(String(text).trim());
  const files = match?.[1].split(/[\s,;]+/u).filter(path => path && path !== '-');
  if (!match || !files.length || files.some(path => path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')
    || !/^[\w.@+/-]+$/u.test(path)) || !match[2].trim() || !match[3].trim()) {
    throw new Refused('DIAGNOSIS_REQUIRED', 'record exact files, the change and its proving test case: pullboard fact <id> diagnosis "Files: packages/cell/file.js Change: the exact fix Test case: the named case and assertion"');
  }
  return { files: [...new Set(files)], change: match[2].trim(), testCase: match[3].trim() };
}

/** Present the diagnosis as the actual cold-builder brief, retaining its exact paths and assertions. */
export function diagnosisBrief(diagnosis) {
  return `Files:\n${diagnosis.files.map(path => `- ${path}`).join('\n')}\nChange:\n${diagnosis.change}\nTest:\n${diagnosis.testCase}`;
}
