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
 * A cell whose red names files gets one rerun of each red file on the same tree: when every rerun is green and main holds a green
 * receipt for that file, the red is a flake on this tree and the proof goes on, recording `flakes` as {file, tree}; a file that is red
 * again, or that main has no green receipt for, ends the proof red naming the file, the rerun and main's receipt (or its absence) [V37].
 * Why: a whole-tree proof meets timing flakes a single file never would, and a flake with no green main behind it is not proven one.
 * With `ports.runBar` (landing.sprintBarTests on) the batch items' frozen bar tests run once after the static stage, before the cells, and
 * `barTests` records [{item, files}]; a bar file that is red (after the same one rerun) or missing ends the proof red naming the item and the file [U147].
 *
 * @param {{ tree: string }} record The batch's exact-tree record, whose tree id this proof is keyed by.
 * @param {{ changedFiles: () => string[] | Promise<string[]>, pin: () => string, runStatic: () => Promise<{ isGreen: boolean, output?: string }>, runCell: (cell: string) => Promise<{ isGreen: boolean, output?: string, files?: string[] }>, runBar?: () => Promise<{ isGreen: boolean, output?: string, files?: string[], refused?: boolean, item?: number, file?: string, items?: { item: number, files: string[] }[] }>, rerunFile?: (file: string) => Promise<{ isGreen: boolean }>, mainReceipt?: (file: string) => { result: string, main?: string, receiptId?: string } | null }} ports
 *   What the proof reads and runs; the caller supplies them so this file imports nothing.
 * @returns {Promise<{ tree: string, pin: string, cells: string[], result: 'green'|'red', failed?: string, output?: string, file?: string, rerun?: 'green'|'red', mainReceipt?: object|null, flakes?: { file: string, tree: string }[] }>}
 */
export async function sprintProof(record, ports) {
  const cells = changedCells(await ports.changedFiles());
  const proof = { ...record, pin: ports.pin(), cells };
  const flakes = [];
  const staticRun = await ports.runStatic();
  if (!staticRun.isGreen) return { ...proof, result: 'red', failed: 'static', ...(staticRun.output ? { output: String(staticRun.output).slice(-2000) } : {}) };
  /** Settle one red run: a red file gets one rerun and main's receipt before the proof is red; returns the red proof, or null when every red file was a flake. */
  const settle = async (run, failed, extra = () => ({})) => {
    const output = run.output ? { output: String(run.output).slice(-2000) } : {};
    if (!ports.rerunFile || !run.files?.length) return { ...proof, result: 'red', failed, ...extra(undefined), ...output };
    for (const file of run.files) {
      const again = await ports.rerunFile(file);
      const receipt = (await ports.mainReceipt?.(file)) ?? null;
      if (!again.isGreen || receipt?.result !== 'green') return { ...proof, result: 'red', failed, file, rerun: again.isGreen ? 'green' : 'red', mainReceipt: receipt, ...(flakes.length ? { flakes } : {}), ...extra(file), ...output };
      flakes.push({ file, tree: record.tree });
    }
    return null;
  };
  if (ports.runBar) {
    // With landing.sprintBarTests on, every batch item's frozen bar tests run on this exact tree, whatever the changed cells select [U147].
    const bar = await ports.runBar();
    proof.barTests = (bar.items ?? []).map(row => ({ item: row.item, files: row.files }));
    const ownerOf = file => bar.items?.find(row => row.files.includes(file))?.item ?? bar.item;
    if (!bar.isGreen) {
      const red = bar.refused ? { ...proof, result: 'red', failed: 'bar', item: bar.item, ...(bar.file ? { barFile: bar.file } : {}), output: String(bar.output ?? '').slice(-2000) }
        : await settle(bar, 'bar', file => ({ item: ownerOf(file) }));
      if (red) return red;
    }
  }
  for (const cell of cells) {
    const run = await ports.runCell(cell);
    if (run.isGreen) continue;
    const red = await settle(run, cell);
    if (red) return red;
  }
  return { ...proof, result: 'green', ...(flakes.length ? { flakes } : {}) };
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
