/** Shared read-only command declaration contracts, below their CLI presentation [C7,A1,N26]. */
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read independent data declarations without loading command implementations. */
export function commandDocs(root = dirname(fileURLToPath(new URL('../../../../package.json', import.meta.url)))) {
  const directory = join(root, 'apps/cli/src/io/command-docs');
  const names = new Set();
  return readdirSync(directory, { recursive: true }).filter(file => file.endsWith('.json')).sort().map(file => {
    const path = join(directory, file);
    if (!/^(?:[a-z][a-z0-9-]*\/)*[a-z][a-z0-9-]*\.json$/u.test(file) || !lstatSync(path).isFile()) throw new Error(`invalid command documentation ${file}`);
    const entry = JSON.parse(readFileSync(path, 'utf8'));
    if (!entry || !/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/u.test(entry.name ?? '') || names.has(entry.name)
        || typeof entry.help !== 'string' || !entry.help.startsWith(`  pullboard ${entry.name}`)
        || !entry.help.endsWith('\n') || !entry.required || typeof entry.required !== 'object' || Array.isArray(entry.required)
        || Object.hasOwn(entry.required, 'version')
        || Object.entries(entry.required).some(([key, value]) => !/^[a-zA-Z][a-zA-Z0-9]*$/u.test(key)
          || typeof value !== 'string' || !/^(?:string|number|boolean|object|array)(?:\|null)?$/u.test(value))) {
      throw new Error(`invalid or duplicate command declaration ${file}`);
    }
    if (!lstatSync(join(root, `apps/cli/src/io/commands/${entry.name.split(' ')[0]}.js`)).isFile()) {
      throw new Error(`${file} needs its actual command implementation`);
    }
    names.add(entry.name);
    return entry;
  });
}

/** Extend existing result contracts, refusing a declaration that silently replaces a shipped shape. */
export function declaredCommandShapes(existing) {
  const result = { ...existing };
  for (const entry of commandDocs()) {
    if (Object.hasOwn(result, entry.name)) throw new Error(`duplicate JSON shape for ${entry.name}`);
    result[entry.name] = { required: { version: 'number', ...entry.required } };
  }
  return result;
}
