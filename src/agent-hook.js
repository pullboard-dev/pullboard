/** Native hooks provide bounded context and warnings, never a blocking decision [I6]. */
import { spawn } from './windows-child-process.js';
import { fileURLToPath } from 'node:url';
import { AGENT_HOOK_EVENTS } from './agent-hooks.js';

/** Run a single owned worker group; no inherited vendor payload can choose executable arguments. */
export async function runAgentHook(io, event) {
  if (!AGENT_HOOK_EVENTS.includes(event) && event !== 'SessionEnd') return 0;
  let response;
  try {
    const result = await new Promise(resolveResult => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./agent-hook-work.js', import.meta.url)), event], {
        cwd: io.cwd, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '', timedOut = false, finished = false;
      /** Retain bounded public board context, excluding diagnostic stderr and vendor transcripts. */
      const capture = chunk => { if (text.length < 8192) text += chunk.toString('utf8').slice(0, 8192 - text.length); };
      child.stdout.on('data', capture);
      child.stderr.resume();
      /** Finish once even when a spawn error precedes the close notification. */
      const finish = status => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        resolveResult({ status, text, timedOut });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        // This process group was created for this one worker, never selected by executable name.
        if (child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* A worker that already closed needs no signal. */ }
        }
        finish(null);
      }, 2000);
      child.once('error', () => finish(null));
      child.once('close', finish);
    });
    if (result.timedOut || result.status !== 0) response = { systemMessage: `Pullboard hook warning: ${result.timedOut ? 'the local nudge timed out' : 'the local nudge could not finish'}; continuing. Run pullboard resume manually.` };
    else if (event === 'SessionStart') response = { hookSpecificOutput: { hookEventName: event, additionalContext: result.text.trim() } };
    else response = result.text.trim() ? { systemMessage: result.text.trim() } : {};
  } catch { response = { systemMessage: 'Pullboard hook warning: the local nudge could not start; continuing. Run pullboard resume manually.' }; }
  io.stdout.write(JSON.stringify(response) + '\n');
  return 0;
}
