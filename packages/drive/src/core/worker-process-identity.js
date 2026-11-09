/** Parse the compact process row used to bind one announced worker PID (the runner binds its landing worker with it) [C7,V4]. */
export function parseWorkerProcessIdentity(output) {
  const match = output.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u);
  if (!match) return null;
  const startedFields = match[5].trim().split(/\s+/u);
  if (startedFields.length !== 5) return null;
  return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
    state: match[4], started: startedFields.join(' ') };
}

/** Build the PID-only process query and its error-reporting command string [C7,V4]. */
export function workerProcessIdentityQuery(pid) {
  const args = ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,stat=,lstart='];
  return { args, command: `ps ${args.join(' ')}` };
}

/** Recognize only timeout failures from this worker's exact process query [C7,V4]. */
export function isWorkerProcessIdentityTimeout(error, pid) {
  const { command } = workerProcessIdentityQuery(pid);
  return error.code === 'ETIMEDOUT' || (error.killed === true && error.signal === 'SIGTERM' && error.cmd === command);
}
