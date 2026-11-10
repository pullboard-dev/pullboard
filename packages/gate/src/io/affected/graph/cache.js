/** Persist complete committed graphs machine-wide, so a fresh checkout reuses main's graph without losing conservative unknown edges [C7,V4]. */
import { cachedMainFact } from '../../../../../codemap/index.js';
import { mainFactToolIdentity } from '../../../../../codemap/index.js';
import { machineHome } from '../../../../../resources/index.js';
import { foreignNodeOptions } from '../../test/isolation.js';

const STRING_MAPS = ['unknown', 'undeclared', 'modules', 'blobs'];
const SET_MAPS = ['reverse', 'docInputs'];
const ARRAY_MAPS = ['imports'];
const SETS = ['testTreeReaders', 'sourceTreeReaders'];
const KEYS = ['version', 'paths', 'importMap', ...STRING_MAPS, ...SET_MAPS, ...ARRAY_MAPS, ...SETS].sort();

/** JSON graph containers contain strings only; no functions, capabilities or prototype-bearing records. */
function strings(value) {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

/** Validate the entire persisted shape before any cached edge becomes selection authority. */
function validGraph(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(KEYS)
    || value.version !== 1 || !strings(value.paths) || new Set(value.paths).size !== value.paths.length
    || !value.importMap || typeof value.importMap !== 'object' || Array.isArray(value.importMap)) return false;
  for (const name of [...STRING_MAPS, ...SET_MAPS, ...ARRAY_MAPS]) {
    const rows = value[name];
    if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string')
      || new Set(rows.map(row => row[0])).size !== rows.length) return false;
    if (STRING_MAPS.includes(name) ? rows.some(row => typeof row[1] !== 'string') : rows.some(row => !strings(row[1]))) return false;
  }
  if (SETS.some(name => !strings(value[name]))) return false;
  const modules = new Set(value.modules.map(row => row[0]));
  if (modules.size !== value.paths.length || value.paths.some(path => !modules.has(path))) return false;
  if (value.imports.length !== modules.size || value.imports.some(row => !modules.has(row[0]))) return false;
  if (value.docInputs.length) return false;
  return true;
}

/** Strip mutable containers to bounded JSON data; shared storage validates again after publication. */
function encode(graph) {
  const value = { version: 1, paths: [...graph.paths], importMap: graph.importMap };
  for (const name of STRING_MAPS) value[name] = [...graph[name]];
  for (const name of [...SET_MAPS, ...ARRAY_MAPS]) value[name] = [...graph[name]].map(([key, values]) => [key, [...values]]);
  for (const name of SETS) value[name] = [...graph[name]];
  return value;
}

/** Every consumer gets fresh Maps, Sets and arrays, including conservative failure facts. */
function decode(value) {
  const graph = { paths: [...value.paths], importMap: structuredClone(value.importMap) };
  for (const name of STRING_MAPS) graph[name] = new Map(value[name]);
  for (const name of SET_MAPS) graph[name] = new Map(value[name].map(([key, values]) => [key, new Set(values)]));
  for (const name of ARRAY_MAPS) graph[name] = new Map(value[name].map(([key, values]) => [key, [...values]]));
  for (const name of SETS) graph[name] = new Set(value[name]);
  return graph;
}

/** Cache only an exact object-verified commit under the controller's actual analyzer/runtime identity. */
export function cachedAffectedGraph(root, commit, derive) {
  if (!/^[a-f0-9]{40,64}$/u.test(commit) || foreignNodeOptions(process.env.NODE_OPTIONS)) return derive();
  const tool = mainFactToolIdentity();
  if (!tool) return derive();
  const identity = { version: 1, commit, tool, node: process.versions.node,
    executable: process.execPath, nodeOptions: process.env.NODE_OPTIONS ?? null };
  const value = cachedMainFact(root, 'affected-graph', identity, () => encode(derive()), validGraph, { home: machineHome() });
  return decode(value);
}
