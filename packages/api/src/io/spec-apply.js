/**
 * The move result a board API move answers with: for a person-signed spec-approve on the view channel with spec.commitOnApply on, the result plus the outcome of
 * applying and committing each approved row; any other move's result unchanged. The apply runs only after the approve itself succeeded, and the API never signs or approves for the person [C7,#11192].
 *
 * @param {{ verb?: string, args?: { ids?: unknown } }} body the move that just succeeded
 * @param {string} personChannel the channel the move came from
 * @param {object} result the move's own result
 * @param {{ cwd: string, remoteAgent?: string }} seat where the move ran
 * @param {Function} runCommand the CLI runner the move ran with
 * @param {() => boolean} commitOnApplyEnabled whether spec.commitOnApply is on, read through the config cell by the caller
 * @returns {Promise<object>} the result, with `applied` when an apply ran
 */
export async function withApplied(body, personChannel, result, seat, runCommand, commitOnApplyEnabled) {
  if (body.verb !== 'spec-approve' || personChannel !== 'view' || !commitOnApplyEnabled()) return result;
  return { ...result, applied: await applyApprovedRows(body.args?.ids, seat, runCommand, personChannel) };
}

/**
 * Run spec apply --row <id> --commit --json through the same runner for each row a person just approved, stopping at the first refusal.
 * Why: the view's approval message names what the apply did, so the move result carries it as `applied`.
 *
 * @param {unknown} ids the approved row ids, comma or space separated
 * @param {{ cwd: string, remoteAgent?: string }} seat where the approve ran
 * @param {Function} runCommand the CLI runner the approve ran with
 * @param {string} personChannel the channel the approve came from
 * @returns {Promise<{ committed: boolean, commit?: string, code?: string, left?: string }>} the last apply's outcome: the new head, or the refusal's one command left
 */
async function applyApprovedRows(ids, seat, runCommand, personChannel) {
  let applied = { committed: false };
  for (const id of String(ids ?? '').split(/[\s,]+/u).filter(Boolean)) {
    let output = '';
    const status = await runCommand(['spec', 'apply', '--row', id, '--commit', '--json'], {
      cwd: seat.cwd,
      ...(seat.remoteAgent ? { remoteAgent: seat.remoteAgent } : {}),
      personChannel,
      stdout: { isTTY: false, write: (text) => { output += text; } },
      stderr: { write: () => {} },
      onEvent: () => {},
    });
    let document;
    try { document = JSON.parse(output); } catch { document = {}; }
    if (status) return { committed: false, ...(document.error?.code ? { code: document.error.code } : {}), ...(document.error?.next ? { left: document.error.next } : {}) };
    applied = document.applied ?? applied;
  }
  return applied;
}
