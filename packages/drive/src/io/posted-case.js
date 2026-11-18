/** The failing test case a red job's output tail names, for the runner's posted log line [C7,#9084]. */

const PREFIX = '# pullboard test outcomes ';

/**
 * The first failing case in a job's output tail, as one short segment: `first failing case: <file>::<name>` and, when
 * more failed, `, +N more`. Empty when the tail holds no outcome frame with a failed case.
 * Why a small parse here: a runner service imports only its own cell, and the frames are plain JSON lines; the tail keeps
 * the last bytes of the output, where the frames survive, and a frame cut by the tail's start is skipped.
 *
 * @param {string} tail - The last bytes of the job's output.
 * @returns {string}
 */
export function firstFailingCase(tail) {
  const failed = [];
  for (const line of String(tail ?? '').split('\n')) {
    if (!line.startsWith(PREFIX)) continue;
    let frame;
    try { frame = JSON.parse(line.slice(PREFIX.length)); } catch { continue; }
    for (const row of Array.isArray(frame?.tests) ? frame.tests : []) {
      if (row && row.passed === false && row.skipped !== true && typeof row.file === 'string' && typeof row.name === 'string') failed.push(row);
    }
  }
  if (!failed.length) return '';
  const name = failed[0].name.length > 160 ? `${failed[0].name.slice(0, 157)}...` : failed[0].name;
  return `first failing case: ${failed[0].file}::${name}${failed.length > 1 ? `, +${failed.length - 1} more` : ''}`;
}
