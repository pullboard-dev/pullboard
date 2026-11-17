/** The Sprint proof on the exact tree main will point to: RFC 0011 ET6 at Sprint, approved 17 Nov 2026 [V16,V37]. */

/** The cells a change touches, sorted: `apps/<name>` or `packages/<name>` for each changed path under one. */
export function changedCells(files) {
  return [...new Set(files.map(file => /^(?:apps|packages)\/[^/]+/u.exec(file)?.[0]).filter(Boolean))].sort();
}

/**
 * Run the Sprint proof for a batch's exact tree and return its record: the tree id, the tooling pin, the cells run and the result.
 * Why: a landing proved on another tree can stand for a tree it never ran on; the record names the tree, the code that ran and what ran.
 * Static checks run first, then each changed cell's tests in turn; the first red stops the proof and is named in `failed`
 * (`static` or the cell), so a red tree never has to run the rest.
 *
 * @param {{ tree: string }} record The batch's exact-tree record, whose tree id this proof is keyed by.
 * @param {{ changedFiles: () => string[], pin: () => string, runStatic: () => Promise<{ isGreen: boolean, output?: string }>, runCell: (cell: string) => Promise<{ isGreen: boolean, output?: string }> }} ports
 *   What the proof reads and runs; the caller supplies them so this file imports nothing.
 * @returns {Promise<{ tree: string, pin: string, cells: string[], result: 'green'|'red', failed?: string, output?: string }>}
 */
export async function sprintProof(record, ports) {
  const cells = changedCells(ports.changedFiles());
  const proof = { ...record, pin: ports.pin(), cells };
  const staticRun = await ports.runStatic();
  if (!staticRun.isGreen) return { ...proof, result: 'red', failed: 'static', ...(staticRun.output ? { output: String(staticRun.output).slice(-2000) } : {}) };
  for (const cell of cells) {
    const run = await ports.runCell(cell);
    if (!run.isGreen) return { ...proof, result: 'red', failed: cell, ...(run.output ? { output: String(run.output).slice(-2000) } : {}) };
  }
  return { ...proof, result: 'green' };
}

/** How many times a staged batch is restaged on a moved main before its items yield their turn (the RFC 0011 approval packet's answer, 17 Nov 2026) [V35]. */
export const RESTAGE_LIMIT = 3;

/**
 * Hold a staged batch to compare-and-set: check that main is still at the base the batch was staged on, and when it is not,
 * restage on the new main and prove the new exact tree again, up to `limit` times; then the batch yields.
 * Why: a proof is keyed by the tree main will point to, so a batch staged on an old main must be rebuilt and proved again, never moved as it is.
 *
 * @param {{ verify: () => Promise<void>, restage: () => Promise<void>, prove: () => Promise<void>, yieldTurn: (restages: number) => Promise<void> }} ports
 *   `verify` throws an error with code LAND_MAIN_MOVED when main left the staged base; any other error ends the loop.
 * @param {number} [limit] The restages allowed before the yield.
 * @returns {Promise<{ restages: number, yielded: boolean }>}
 */
export async function stageUntilCurrent(ports, limit = RESTAGE_LIMIT) {
  for (let restages = 0; ; restages++) {
    try {
      await ports.verify();
      return { restages, yielded: false };
    } catch (error) {
      if (error?.code !== 'LAND_MAIN_MOVED') throw error;
    }
    if (restages >= limit) {
      await ports.yieldTurn(restages);
      return { restages, yielded: true };
    }
    await ports.restage();
    await ports.prove();
  }
}
