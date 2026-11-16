/**
 * The thin entry for a bare `pullboard heartbeat`: one seat lookup and one sidecar timestamp write, never the command
 * registry or queued-handoff recovery. A seat loop beats every 30 s, and 33 of them each booting the whole CLI used
 * about 8 cores on 8 Nov [C7,#3847]. Claims ride the seat's beat, so one write renews every claim of the seat.
 */
import { appendTrace } from '../trace.js';
import { openPulse } from '../../../../../packages/seats/pulse.js';
import { writePulse } from '../../../../../packages/store/pulse.js';

/**
 * Beat the seat acting from `cwd` and return the exit code, or null when the full path must run it (no seat here).
 *
 * @param {{ cwd: string, stderr: { write(text: string): unknown } }} streams
 * @returns {number | null}
 */
export function runThinHeartbeat({ cwd, stderr }) {
  const pulse = openPulse(cwd);
  if (!pulse) return null;
  const startedAt = Date.now();
  try { writePulse(pulse.board, pulse.seat); } catch (error) { stderr.write(`presence heartbeat unavailable: ${error.message}\n`); }
  stderr.write('next: pullboard next\n');
  pulse.finish();
  appendTrace({ argv: ['heartbeat'], cwd, startedAt, status: 0, seat: pulse.seat });
  return 0;
}
