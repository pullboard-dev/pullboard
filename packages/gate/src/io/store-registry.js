/**
 * The store registry file and the views of it that other cells read: where it is, its parsed rows, and the disk groups
 * its rows name [CD2,C7]. Why a module of its own: the registry file has one home, and a reader such as the disk report
 * must not load the whole store scan to find it.
 */
import { readFileSync } from 'node:fs';

export const STORE_REGISTRY = 'packages/gate/data/baselines/stores.json';
export const STORE_REGISTRY_URL = new URL('../../data/baselines/stores.json', import.meta.url);

/** The shipped registry, parsed. */
export function storeRegistry() {
  return JSON.parse(readFileSync(STORE_REGISTRY_URL, 'utf8'));
}

/**
 * The names under .git/pullboard that make up each disk group: a row's `disk` group, plus the names the registry lists
 * as `disk.unlisted` (files with no row of their own, such as SQLite sidecars). Why: one registry names every store, so
 * a store added there cannot be left out of the disk report.
 *
 * @param {{ disk: { groups: string[], unlisted?: Record<string, string[]> }, stores: Record<string, { disk?: string }>, dirs?: Record<string, { disk?: string }> }} registry
 * @returns {Record<string, string[]>} Group name to top-level names; the group `other` is never listed.
 */
export function diskStoresFrom(registry) {
  const stores = Object.fromEntries(registry.disk.groups.map(group => [group, [...(registry.disk.unlisted?.[group] ?? [])]]));
  for (const rows of [registry.stores, registry.dirs ?? {}]) {
    for (const [name, row] of Object.entries(rows)) if (stores[row.disk]) stores[row.disk].push(name);
  }
  return stores;
}

/** The disk groups of the shipped registry (see diskStoresFrom). */
export function diskStores() {
  return diskStoresFrom(storeRegistry());
}
