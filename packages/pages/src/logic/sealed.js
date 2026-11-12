/** Bounded, device-sealed snapshot objects; plaintext and private cache fingerprints never reach the relay [H15,H17]. */
import { Refused } from "../../../kernel/light.js";
import {
  seal,
  unseal,
} from "../../../kernel/browser.js";

export const PAGE_BYTES = 262_144;
export const PAGE_FANOUT = 64;
export const PAGE_CIPHER_BYTES = 400_000;
const PREFIX = new TextEncoder().encode('pullboard-sealed-page/1\n');
const MAX_DEPTH = 32;

/** Refuse malformed pages without repeating authenticated content or private material. */
function invalid() {
  return new Refused('SNAPSHOT_PAGE_FORMAT', 'This sealed snapshot page is invalid. Refresh it from a linked machine or upgrade this device.');
}

/** Validate a content address and its authenticated position before requesting any bytes. */
export function pageReference(value) {
  if (!value || !/^[0-9a-f]{64}$/u.test(value.id ?? '') || !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 0) throw invalid();
  return { id: value.id, sequence: value.sequence, bytes: value.bytes };
}

/** Hash only explicit bytes; plaintext fingerprints are for the device's private reuse cache. */
export async function pageDigest(bytes) {
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** Consume a compression stream with a limit before allocating its complete result. */
async function transformed(bytes, compress, limit) {
  const stream = new Blob([bytes]).stream().pipeThrough(compress ? new CompressionStream('gzip') : new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const parts = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw invalid();
      parts.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw invalid();
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

/** Encode one bounded leaf or index, reusing only a device-private content lookup. */
async function writePage(kind, body, children, logicalBytes, context) {
  if (body.byteLength > PAGE_BYTES || !Number.isSafeInteger(logicalBytes) || logicalBytes < 0) throw invalid();
  const plain = new Uint8Array(PREFIX.byteLength + 1 + body.byteLength);
  plain.set(PREFIX); plain[PREFIX.byteLength] = kind; plain.set(body, PREFIX.byteLength + 1);
  const fingerprint = await pageDigest(plain);
  const reused = await context.lookup?.(fingerprint);
  if (reused) {
    const reference = pageReference(reused);
    if (reference.bytes !== logicalBytes) throw invalid();
    return reference;
  }
  const compressed = await transformed(plain, true, PAGE_CIPHER_BYTES);
  const bytes = await seal(context.key, compressed, { boardId: context.boardId, kind: 'snapshot', sequence: context.sequence });
  if (bytes.byteLength > PAGE_CIPHER_BYTES) throw invalid();
  const reference = pageReference({ id: await pageDigest(bytes), sequence: context.sequence, bytes: logicalBytes });
  // Only ciphertext identities and ciphertext are suitable for an upload. The reuse fingerprint stays a separate callback.
  await context.put({ id: reference.id, sequence: reference.sequence, bytes, children: children.map(child => child.id) });
  await context.remember?.(fingerprint, reference);
  return reference;
}

/** Seal one bounded index; its authenticated children carry the exact uncompressed length of each subtree. */
async function writeIndex(children, context) {
  if (!children.length || children.length > PAGE_FANOUT) throw invalid();
  const references = children.map(pageReference);
  const length = references.reduce((sum, child) => sum + child.bytes, 0);
  return writePage(0, new TextEncoder().encode(JSON.stringify(references)), references, length, context);
}

/** Seal a bounded typed directory whose encrypted references also bind the relay's opaque reachability edges. */
export async function writeSealedDescriptor(value, rawLinks, context) {
  if (!Array.isArray(rawLinks) || rawLinks.length > PAGE_FANOUT) throw invalid();
  const links = rawLinks.map(pageReference);
  let body;
  try { body = new TextEncoder().encode(JSON.stringify({ value, links })); } catch { throw invalid(); }
  return writePage(2, body, links, body.byteLength, context);
}

/**
 * Seal JSON as a stream of bounded objects and bounded-fanout indexes, with no aggregate transport size cap.
 * The supplied value is already materialized by its caller; this does not promise constant memory for building that value.
 * put receives only upload-safe ciphertext metadata. lookup/remember are private device cache hooks, never relay fields.
 */
export async function writeSealedValue(value, context) {
  let json;
  try { json = JSON.stringify(value); } catch { throw invalid(); }
  if (json === undefined || typeof context?.put !== 'function') throw invalid();
  const bytes = new TextEncoder().encode(json);
  const levels = [];
  /** Flush complete groups upward without retaining a flat list of every chunk. */
  async function append(reference, level = 0) {
    if (level >= MAX_DEPTH) throw invalid();
    const siblings = levels[level] ??= [];
    siblings.push(reference);
    if (siblings.length === PAGE_FANOUT) {
      levels[level] = [];
      await append(await writeIndex(siblings, context), level + 1);
    }
  }
  for (let offset = 0; offset < bytes.byteLength; offset += PAGE_BYTES) {
    const body = bytes.subarray(offset, offset + PAGE_BYTES);
    await append(await writePage(1, body, [], body.byteLength, context));
  }
  let highest = levels.length - 1;
  while (highest >= 0 && !levels[highest]?.length) highest -= 1;
  let tail = null;
  for (let level = 0; level <= highest; level += 1) {
    const siblings = [...(levels[level] ?? []), ...(tail ? [tail] : [])];
    if (!siblings.length) continue;
    if (level === highest && siblings.length === 1) return siblings[0];
    tail = await writeIndex(siblings, context);
  }
  if (!tail) throw invalid();
  return tail;
}

/** Authenticate, bound inflation and parse a single object before interpreting its references. */
async function readPage(reference, context, parents = []) {
  if (typeof context.bound === 'function') return context.bound(() => readPage(reference, { ...context, bound: undefined }, parents));
  const received = await context.get(reference.id, parents);
  if (!(received instanceof Uint8Array) || received.byteLength > PAGE_CIPHER_BYTES || await pageDigest(received) !== reference.id) throw invalid();
  const compressed = await unseal(context.key, received, { boardId: context.boardId, kind: 'snapshot', sequence: reference.sequence });
  const plain = await transformed(compressed, false, PAGE_BYTES + PREFIX.byteLength + 1);
  if (plain.byteLength <= PREFIX.byteLength || PREFIX.some((byte, index) => plain[index] !== byte)) throw invalid();
  const kind = plain[PREFIX.byteLength];
  const body = plain.subarray(PREFIX.byteLength + 1);
  const fingerprint = await pageDigest(plain);
  /** Retain only an authenticated cipher and its checked edges in an optional private device cache. */
  async function remembered(result, links = []) {
    await context.rememberRead?.({ id: reference.id, sequence: reference.sequence, bytes: received,
      children: links.map(child => child.id) }, fingerprint, reference);
    return result;
  }
  if (kind === 1) {
    if (body.byteLength !== reference.bytes) throw invalid();
    return remembered({ body, fingerprint });
  }
  if (kind === 2) {
    if (body.byteLength !== reference.bytes) throw invalid();
    let descriptor;
    try { descriptor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { throw invalid(); }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !Array.isArray(descriptor.links) || descriptor.links.length > PAGE_FANOUT) throw invalid();
    const links = descriptor.links.map(pageReference);
    return remembered({ descriptor: { value: descriptor.value, links }, fingerprint }, links);
  }
  if (kind !== 0) throw invalid();
  let children;
  try { children = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { throw invalid(); }
  if (!Array.isArray(children) || !children.length || children.length > PAGE_FANOUT) throw invalid();
  children = children.map(pageReference);
  const length = children.reduce((sum, child) => sum + child.bytes, 0);
  if (!Number.isSafeInteger(length) || length !== reference.bytes) throw invalid();
  return remembered({ children, fingerprint }, children);
}

/** Authenticate a private cache hit before trusting its plaintext fingerprint; never upload the result. */
export async function sealedPageFingerprint(reference, context) { return (await readPage(pageReference(reference), context)).fingerprint; }

/**
 * Yield authenticated JSON bytes one bounded leaf at a time. A shared subtree may appear twice; only ancestor cycles refuse.
 * maxBytes is a consumer's allocation budget for this value, independent of the size of the board's other paged values.
 */
export async function* readSealedBytes(rawReference, context, { maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
  const root = pageReference(rawReference);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || root.bytes > maxBytes || typeof context?.get !== 'function') throw invalid();
  const ancestors = new Set();
  /** Walk in authenticated byte order, without requesting later siblings before they are consumed. */
  async function* walk(reference, depth, parents) {
    if (depth >= MAX_DEPTH || ancestors.has(reference.id)) throw invalid();
    ancestors.add(reference.id);
    try {
      const page = await readPage(reference, context, parents);
      if (page.body) yield page.body;
      else if (page.children) for (const child of page.children) yield* walk(child, depth + 1, [...parents, reference.id]);
      else throw invalid();
    } finally { ancestors.delete(reference.id); }
  }
  yield* walk(root, 0, context.parents ?? []);
}

/** Read a selected authenticated directory without traversing any of its unrelated children. */
export async function readSealedDescriptor(reference, context) {
  const page = await readPage(pageReference(reference), context, context.parents ?? []);
  if (!page.descriptor) throw invalid();
  return page.descriptor;
}

/** Read one selected JSON value; unrelated history values are neither fetched nor decrypted here. */
export async function readSealedValue(reference, context, options) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts = [];
  try {
    for await (const bytes of readSealedBytes(reference, context, options)) parts.push(decoder.decode(bytes, { stream: true }));
    parts.push(decoder.decode());
    return JSON.parse(parts.join(''));
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw invalid();
  }
}
