/** Put the pinned tooling on a runner once: a runner that holds the pin's tree reads its copy and is sent no bytes [C7]. */
import { readFileSync } from 'node:fs';
import { shellWord } from '../logic/frames.js';

/** A refusal with a stable code, kept local so this file adds no cross-cell import. */
function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

/** True for a full lowercase git object id, the only name a tooling folder accepts. */
function isTreeId(id) {
  return typeof id === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(id);
}

/**
 * The runner folder that holds one tooling tree, as a shell expression: `<root>/tooling/<tree>`.
 *
 * Why: the folder is named by tooling tree id alone, so any gate whose pin names that tree finds the same copy.
 *
 * @param {string | undefined} root - The runner's registered root, or the runner user's home default.
 * @param {string} tree - The tooling tree id.
 * @returns {string}
 */
export function toolingFolder(root, tree) {
  if (!isTreeId(tree)) throw refuse('TRANSPORT_TOOLING_TREE', 'the tooling pin must name a full tree id; resolve it with toolingFor first');
  const base = typeof root === 'string' && root ? shellWord(root) : '"$HOME/.pullboard-runner"';
  return `${base}/tooling/${tree}`;
}

/**
 * Make sure the runner holds the tooling tree the pin names, sending the bundle only when it does not.
 *
 * Why: copying tooling cost every gate minutes. The runner marks a copy complete only after it unpacked whole, so
 * a held pin is read in place: the gate sends zero tooling bytes and says so in its log.
 *
 * @param {{ run: Function, runner: object }} channel - A runner channel from connect(runner).
 * @param {{ tree: string, bundle: string }} tooling - The pin's tooling tree id and the path of its tar bundle.
 * @param {(line: string) => void} [log] - Receives the gate log line.
 * @returns {Promise<{ tree: string, path: string, held: boolean, bytesSent: number }>} Where the tooling is and what was sent.
 */
export async function ensureTooling(channel, { tree, bundle }, log = () => {}) {
  const folder = toolingFolder(channel.runner.root, tree);
  const probe = await channel.run(`d=${folder}\nif [ -f "$d/.complete" ]; then printf held; printf %s "$d"; else printf absent; fi`);
  const reply = probe.output.toString('utf8');
  if (probe.status !== 0) throw refuse('TRANSPORT_TOOLING_PROBE', `could not check the tooling pin on runner ${channel.runner.host} (status ${probe.status}); retry on a fresh channel`);
  if (reply.startsWith('held')) {
    log(`tooling pin ${tree} held on ${channel.runner.host}: tooling bytes sent: 0`);
    return { tree, path: reply.slice(4), held: true, bytesSent: 0 };
  }
  const bytes = readFileSync(bundle);
  const sent = await channel.run([
    `d=${folder}`,
    `rm -rf "$d.partial" && mkdir -p "$d.partial" || exit 3`,
    `printf %s ${shellWord(bytes.toString('base64'))} | (base64 -d 2>/dev/null || base64 -D) | tar -x -C "$d.partial" || exit 4`,
    `: > "$d.partial/.complete" && rm -rf "$d" && mv "$d.partial" "$d" || exit 5`,
    `printf %s "$d"`,
  ].join('\n'));
  if (sent.status !== 0) throw refuse('TRANSPORT_TOOLING_SEND', `tooling ${tree} did not unpack on runner ${channel.runner.host} (status ${sent.status}); check the runner root is writable`);
  log(`tooling pin ${tree} sent to ${channel.runner.host}: tooling bytes sent: ${bytes.length}`);
  return { tree, path: sent.output.toString('utf8'), held: false, bytesSent: bytes.length };
}
