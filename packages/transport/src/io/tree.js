/** Tree-id source: a gate names its candidate by tree id and sends the runner only the objects its store lacks [C7]. */
import { shellWord } from '../logic/frames.js';

/** True for a full lowercase git object id, the only name a source folder accepts. */
function isObjectId(id) {
  return typeof id === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(id);
}

/** A refusal with a stable code, kept local so this file adds no cross-cell import. */
function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Make sure the runner holds the candidate's source tree, sending only the objects its store lacks.
 *
 * Why: this is the production path the gate takes in place of a fresh checkout per gate. The runner keeps one bare
 * object store and one materialised folder per tree id (`<root>/source/<tree>`), so a runner that already holds
 * the tree is sent nothing, and a second gate on the same base is sent only the changed blobs and trees [C7].
 *
 * @param {{ run: Function, runner: object }} channel - A runner channel from connect(runner).
 * @param {{ tree: string, objects: () => Promise<string[]>, pack: (ids: string[]) => Promise<Buffer> }} source - The candidate's full tree id, a lister of every object id the tree holds, and a packer for chosen ids (the sender's own git, passed in).
 * @param {(line: string) => void} [log] - Receives the gate log line.
 * @returns {Promise<{ tree: string, path: string, held: boolean, total: number, sent: number, reused: number, bytesSent: number }>} Where the source is and what was sent.
 */
export async function ensureSource(channel, { tree, objects, pack: packer }, log = () => {}) {
  if (!isObjectId(tree)) throw refuse('TREE_SOURCE_INVALID', 'A source is named by a full tree id; resolve the commit with pinFor first.');
  const root = channel.runner.root;
  const base = typeof root === 'string' && root ? shellWord(root) : '"$HOME/.pullboard-runner"';
  const folder = `${base}/source/${tree}`;
  const store = `${base}/objects.git`;
  const probe = await channel.run(`d=${folder}\nif [ -f "$d/.complete" ]; then printf held; printf %s "$d"; else printf absent; fi`);
  if (probe.status !== 0) throw refuse('TREE_SOURCE_PROBE', `could not check the source on runner ${channel.runner.host} (status ${probe.status}); retry on a fresh channel`);
  const reply = probe.output.toString('utf8');
  if (reply.startsWith('held')) {
    log(`source tree ${tree} held on ${channel.runner.host}: source objects sent: 0`);
    return { tree, path: reply.slice(4), held: true, total: 0, sent: 0, reused: 0, bytesSent: 0 };
  }
  const ids = await objects();
  const decode = '(base64 -d 2>/dev/null || base64 -D)';
  const asked = await channel.run([
    `s=${store}`,
    `[ -d "$s" ] || git init --bare -q "$s" || exit 3`,
    `printf %s ${shellWord(Buffer.from(`${ids.join('\n')}\n`).toString('base64'))} | ${decode} | git --git-dir "$s" cat-file --batch-check`,
  ].join('\n'));
  if (asked.status !== 0) throw refuse('TREE_SOURCE_STORE_FAILED', `the object store on runner ${channel.runner.host} could not be read (status ${asked.status}); check git is installed and the runner root is writable`);
  const lacking = asked.output.toString('utf8').split('\n').filter(line => line.endsWith(' missing')).map(line => line.split(' ')[0]);
  let bytesSent = 0;
  if (lacking.length) {
    const pack = await packer(lacking);
    const received = await channel.run(`s=${store}\nprintf %s ${shellWord(pack.toString('base64'))} | ${decode} | git --git-dir "$s" unpack-objects -q || exit 4`);
    if (received.status !== 0) throw refuse('TREE_SOURCE_STORE_FAILED', `runner ${channel.runner.host} did not take the objects (status ${received.status}); retry the gate`);
    bytesSent = pack.length;
  }
  const made = await channel.run([
    `d=${folder}`,
    `s=${store}`,
    `rm -rf "$d.partial" && mkdir -p "$d.partial" || exit 3`,
    `git --git-dir "$s" archive --format=tar ${tree} | tar -x -C "$d.partial" || exit 4`,
    `: > "$d.partial/.complete" && rm -rf "$d" && mv "$d.partial" "$d" || exit 5`,
    `printf %s "$d"`,
  ].join('\n'));
  if (made.status !== 0) throw refuse('TREE_SOURCE_MATERIALISE', `source ${tree} did not unpack on runner ${channel.runner.host} (status ${made.status}); check the runner root is writable`);
  log(`source tree ${tree} sent to ${channel.runner.host}: ${lacking.length} of ${ids.length} objects, source bytes sent: ${bytesSent}`);
  return { tree, path: made.output.toString('utf8'), held: false, total: ids.length, sent: lacking.length, reused: ids.length - lacking.length, bytesSent };
}
