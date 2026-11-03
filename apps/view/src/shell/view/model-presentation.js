/** Private Cost model names; imported only at a private presentation boundary [N26,P5]. */
/** Name private view models and rate keys without constraining native model or family declarations. */
export function modelPresentation(reported, family = '') {
  const named = typeof reported === 'string' ? reported.trim() : '';
  // A "/vendor" suffix is the declared family, not part of the model: "GPT-6/openai" is "GPT-6".
  const slash = named.indexOf('/'), raw = slash > 0 ? named.slice(0, slash).trim() : named;
  if (slash > 0 && !String(family).trim()) family = named.slice(slash + 1).trim();
  const key = raw.toLowerCase().replace(/[\s_]+/gu, '-');
  const known = {
    'claude-opus-5-5': ['Opus 5.5', 'Anthropic'],
    'claude-sonnet-5-5': ['Sonnet 5.5', 'Anthropic'],
    'gpt-6.1-sol': ['GPT-6.1 Sol', 'OpenAI'],
    'gpt-6.1-terra': ['GPT-6.1 Terra', 'OpenAI'],
    'gpt-6-luna': ['GPT-6 Luna', 'OpenAI'],
    codex: ['Codex', 'OpenAI'],
    'gpt-6-codex': ['Codex', 'OpenAI'],
  };
  const vendors = { openai: 'OpenAI', gpt: 'OpenAI', codex: 'OpenAI', anthropic: 'Anthropic', claude: 'Anthropic', google: 'Google', gemini: 'Google' };
  const familyKey = String(family).trim().toLowerCase();
  let name = raw, vendor = Object.hasOwn(vendors, familyKey) ? vendors[familyKey] : 'Other';
  if (Object.hasOwn(known, key)) [name, vendor] = known[key];
  else {
    const claude = /^claude-([a-z][a-z-]*)-(\d+)-(\d+)$/u.exec(key);
    if (claude) { name = claude[1].split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ') + ' ' + claude[2] + '.' + claude[3]; vendor = 'Anthropic'; }
    else if (/^(?:gpt-|o\d|codex)/u.test(key)) {
      vendor = 'OpenAI';
      name = key.split('-').filter(Boolean).map((word, index) => index === 0 && word === 'gpt' ? 'GPT' : /^\d/u.test(word) || /^o\d/u.test(word) ? word : word[0]?.toUpperCase() + word.slice(1)).join(' ').replace(/^GPT /u, 'GPT-');
    } else if (/^gemini/u.test(key)) { vendor = 'Google'; name = key.split('-').filter(Boolean).map(word => word[0]?.toUpperCase() + word.slice(1)).join(' '); }
  }
  return { key, name, vendor };
}

