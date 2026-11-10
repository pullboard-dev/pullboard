/** Typed prerequisites keep another repository's item out of local Git dependency paths [B24,H16]. */
import { dependencyReferences } from "../../../seats/browser.js";
export {
  dependencyReferences,
  localDependencyIds,
  parseDependency,
  validateNativeDependencies,
} from "../../../seats/browser.js";

/** Preserve the historical numeric local representation and the exact qualified repository name. */
export function dependencyValues(value) {
  return dependencyReferences(value).map(ref => ref.kind === 'local' ? ref.id : `${ref.repo}#${ref.id}`);
}

/** Keep unavailable foreign prerequisites visible until their own board's authority resolves them. */
export function foreignDependencies(value) {
  return dependencyReferences(value).filter(ref => ref.kind === 'foreign');
}

/** Display a local item with its hash, retaining the repository on a foreign item. */
export function dependencyLabel(ref) {
  return ref.kind === 'local' ? `#${ref.id}` : `${ref.repo}#${ref.id}`;
}

/** Detect the new wire shape without changing the native validation of malformed older arguments. */
export function hasForeignDependencies(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) value = value.item_after;
  const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return parts.some(part => typeof part === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}#[1-9][0-9]*$/u.test(part));
}
