/** The clock's folder row for an ended claim: the folder goes, and a dirty diff is kept at a board ref first [B5,C7,#12530]. */
/** The keep ref for an item: refs/pullboard/keep/<id>, or the first free <id>-<n>, so an earlier keep is never overwritten. */
export function claimEndedKeepRef(name, exists) {
  let ref = `refs/pullboard/keep/${name}`;
  for (let n = 2; exists(ref); n++) ref = `refs/pullboard/keep/${name}-${n}`;
  return ref;
}

/** The fact text that names the kept commit on the item. */
export function claimEndedFact(record) {
  return `Item folder ${JSON.stringify(record.path)} removed because its claim ended (rule ${record.rule}); uncommitted work, untracked files included, is kept at ${record.ref} as commit ${record.commit}.`;
}

/**
 * Run the folder sweep for one clock pass: the same maintenance pass the hourly timer runs, so the folder row's deadline
 * holds between timer ticks. A board without worktree maintenance enabled is left alone.
 */
export async function clockFolderSweep(ctx, root) {
  if (ctx.config.worktreeMaintenance?.enabled !== true) return null;
  const { runWorktreeMaintenance } = await import('../maintenance.js');
  const { maintenanceCommandPorts } = await import('./command.js');
  return runWorktreeMaintenance(root, ctx.config, maintenanceCommandPorts(ctx, 'coordinator'), { now: ctx.clock.now().getTime() });
}
