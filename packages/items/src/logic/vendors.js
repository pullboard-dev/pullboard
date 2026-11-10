/** Small explicit vendor spellings; unlisted declarations retain their normalized names [V4,B26]. */
const VENDORS = {
  openai: ['openai', 'codex', 'gpt', 'chatgpt'],
  anthropic: ['anthropic', 'claude', 'sonnet', 'opus', 'haiku'],
  google: ['google', 'gemini'],
  xai: ['xai', 'grok'],
  deepseek: ['deepseek'],
  mistral: ['mistral'],
};
const BUILTINS = new Map(Object.entries(VENDORS).flatMap(([vendor, names]) => names.map(name => [name, vendor])));

/** Retain custom unknown aliases while keeping known vendor names canonical and independent of configuration. */
export function vendorFamilyAliases(custom) {
  const index = new Map(BUILTINS);
  for (const [alias, canonical] of custom ?? []) {
    const name = alias.trim().toLowerCase(), vendor = canonical.trim().toLowerCase();
    if (!BUILTINS.has(name)) index.set(name, BUILTINS.get(vendor) ?? vendor);
  }
  return index;
}
