/** The pull protocol over plain HTTP: the board serves, and a reference runner that opens every connection itself [C7]. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createPrivateKey } from 'node:crypto';
import { sign } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Refused } from '../../../../kernel/light.js';
import { pullStatement } from '../pull.js';
import { createWireServer } from '../wire.js';
import { wireRequest } from '../wire.js';

// Budget: one posted result file or request body; a larger output belongs in a report file, not the result.
const BODY_LIMIT = 16 * 1024 * 1024;

/**
 * The path of a request target, without its query.
 *
 * Why: the server routes on the path alone, and a plain split keeps this file free of two-argument URL forms the
 * runner packager reads as opaque source-relative files.
 *
 * @param {string} target
 * @returns {string}
 */
function requestPath(target) {
  return String(target ?? '/').split(/[?#]/u)[0];
}

/**
 * A board endpoint URL from the board's base address and an absolute pull path.
 *
 * @param {string} board
 * @param {string} path
 * @returns {URL}
 */
function boardUrl(board, path) {
  return new URL(`${new URL(board).origin}${path}`);
}

/** Read a request body up to the limit. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) { reject(new Refused('PULL_BODY_LIMIT', `a pull request body is capped at ${BODY_LIMIT} bytes`)); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', reject);
  });
}

/** The bearer token on a request, or an empty string. */
function bearer(request) {
  const header = String(request.headers.authorization ?? '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

/** Send a JSON reply. */
function reply(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * The board's HTTP face of a pull adapter. Routes: POST /pull/register, POST /pull/take, GET /pull/bundle/<tree>,
 * POST /pull/heartbeat and POST /pull/result/<shard>; the last three need the job token as a bearer.
 * A refusal answers 403 with its code and message, so a runner can show the next step.
 *
 * Why: plain HTTP, JSON and a tar keep any sandbox able to speak it with curl, tar, sh and an Ed25519 signer.
 *
 * @param {ReturnType<typeof import('../pull.js').pullAdapter>} adapter
 * @returns {import('http').Server} A server, not yet listening.
 */
export function pullServer(adapter) {
  return createWireServer(async (request, response) => {
    try {
      const [, root, route, name] = requestPath(request.url).split('/');
      if (root !== 'pull') return reply(response, 404, { code: 'PULL_ROUTE', message: 'no such pull route' });
      if (request.method === 'POST' && route === 'register') return reply(response, 200, adapter.register(JSON.parse(await readBody(request))));
      if (request.method === 'POST' && route === 'take') {
        const job = adapter.take(JSON.parse(await readBody(request)));
        if (!job) { response.writeHead(204); return response.end(); }
        return reply(response, 200, job);
      }
      if (request.method === 'GET' && route === 'bundle') {
        const path = adapter.bundle(bearer(request), name);
        response.writeHead(200, { 'content-type': 'application/x-tar' });
        return createReadStream(path).pipe(response);
      }
      if (request.method === 'POST' && route === 'heartbeat') return reply(response, 200, { renewed: adapter.heartbeat(bearer(request)) });
      if (request.method === 'POST' && route === 'result') {
        const bytes = await readBody(request);
        return reply(response, 200, adapter.post(bearer(request), name, bytes, request.headers['x-pullboard-signature']));
      }
      return reply(response, 404, { code: 'PULL_ROUTE', message: 'no such pull route' });
    } catch (error) {
      if (!response.headersSent) reply(response, error instanceof Refused ? 403 : 400, { code: error.code ?? 'PULL_REQUEST', message: error.message });
      else response.destroy();
    }
  });
}

/**
 * Make one outbound HTTP or HTTPS call to the board and collect the whole reply.
 *
 * Why: the runner only ever dials out, so this is its single network call and it needs nothing past the wire door.
 *
 * @param {URL} url
 * @param {{ method?: string, body?: Buffer | string, headers?: object }} [options]
 * @returns {Promise<{ status: number, bytes: Buffer }>}
 */
function boardCall(url, { method = 'GET', body, headers = {} } = {}) {
  const send = wireRequest(url);
  return new Promise((resolve, reject) => {
    const outgoing = send(url, { method, headers }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.once('end', () => resolve({ status: incoming.statusCode, bytes: Buffer.concat(chunks) }));
      incoming.once('error', reject);
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

/** Turn a board answer into its JSON body, or throw the board's refusal. */
function answer(response) {
  if (response.status === 204) return null;
  const body = JSON.parse(response.bytes.toString('utf8'));
  if (response.status !== 200) throw new Refused(body.code ?? 'PULL_REQUEST', body.message ?? `the board answered ${response.status}`);
  return body;
}

/** Run one shard's command with sh in the unpacked tree and return its exit status and combined output. */
function runCommand(command, cwd) {
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => chunks.push(chunk));
    child.once('error', error => resolve({ status: 127, output: Buffer.from(String(error.message)) }));
    child.once('close', status => resolve({ status: status ?? 128, output: Buffer.concat(chunks) }));
  });
}

/** Unpack a tar into a folder with the runner's own tar. */
function untar(file, folder) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', file, '-C', folder], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', status => status === 0 ? resolve() : reject(new Refused('PULL_BUNDLE_UNPACK', `tar exited ${status} unpacking ${file}`)));
  });
}

/**
 * A reference pull runner. It never listens: it registers its key, takes a job, fetches the job's tree bundle by tree
 * id (skipped when it already holds that tree), runs each shard's project command with sh, and posts each result
 * file signed with its key. It holds no board credential beyond the job token take returns.
 *
 * Why: the protocol is the product and this is one client of it; a sandbox in any language can do the same.
 *
 * @param {{ board: string, runner: string, publicKey: string, privateKey: string, workdir: string, now?: () => number }} options
 *   publicKey is base64url SPKI DER; privateKey is PKCS#8 PEM.
 * @returns {{ register: () => Promise<object>, runOnce: () => Promise<object | null> }}
 */
export function pullRunner({ board, runner, publicKey, privateKey, workdir, now = Date.now }) {
  const key = createPrivateKey(privateKey);
  const signText = text => sign(null, Buffer.from(text), key).toString('base64url');
  const post = (path, body, headers = {}) => boardCall(boardUrl(board, path), { method: 'POST', body, headers });

  return {
    /** Register this runner's key with the board. */
    async register() {
      const at = now();
      return answer(await post('/pull/register', JSON.stringify({ runner, publicKey, at, signature: signText(pullStatement('register', runner, at)) })));
    },

    /** Take one job, run its shards and post their signed results; null when the board offers nothing. */
    async runOnce() {
      const at = now();
      const nonce = randomBytes(16).toString('base64url');
      const job = await answer(await post('/pull/take', JSON.stringify({ runner, at, nonce, signature: signText(pullStatement('take', runner, at, nonce)) })));
      if (!job) return null;
      const auth = { authorization: `Bearer ${job.token}` };
      const tree = join(workdir, 'trees', job.tree);
      let fetched = false;
      if (!existsSync(tree)) {
        const got = await boardCall(boardUrl(board, `/pull/bundle/${job.tree}`), { headers: auth });
        if (got.status !== 200) answer(got);
        mkdirSync(join(workdir, 'bundles'), { recursive: true });
        const file = join(workdir, 'bundles', `${job.tree}.tar`);
        writeFileSync(file, got.bytes);
        mkdirSync(tree, { recursive: true });
        await untar(file, tree);
        fetched = true;
      }
      const posted = [];
      for (const { shard, command } of job.shards) {
        const { status, output } = await runCommand(command, tree);
        const bytes = Buffer.concat([Buffer.from(`PBRESULT 1 ${status} ${output.length}\n`), output]);
        const digest = createHash('sha256').update(bytes).digest('hex');
        // The receipt cell's resultStatement, built independently: PBSIGNED 2 with every field length-prefixed.
        const field = value => `${Buffer.byteLength(String(value))}:${value}`;
        const statement = ['PBSIGNED 2', job.job, shard, job.tree, digest, job.base ?? '', job.tooling ?? '', command, job.attempt ?? ''].map(field).join('\n');
        const signature = signText(statement);
        posted.push(await answer(await post(`/pull/result/${shard}`, bytes, { ...auth, 'x-pullboard-signature': signature })));
      }
      return { job: job.job, tree: job.tree, fetched, posted };
    },
  };
}
