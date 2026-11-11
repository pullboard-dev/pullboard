/** Explicit legacy questions for answer/approval controls, independent of day-zero defaults [S1,B26]. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Keep question workflows under test without making the current bundled web app ask questions. */
export function legacyWebQuestions(blueprint) {
  return { ...blueprint, defaults: [], questions: [
    { key: 'Q1', ask: 'The app is built with', choices: ['Next.js', 'SvelteKit', 'Rails', 'Something else'], detect: 'framework' },
    { key: 'Q2', ask: 'It deploys to', choices: ['Vercel', 'Netlify', 'Fly.io', 'My own server'], default: 'Vercel' },
    { key: 'Q3', ask: 'People sign in with', choices: ['Email links', 'Passwords', 'Google', 'No sign-in yet'], default: 'Email links' },
    { key: 'Q4', ask: 'A change is done when', choices: ['It runs on a preview link', 'Its tests pass', 'I have looked at it'], default: 'It runs on a preview link' },
  ] };
}

/** Materialize the identical explicit template in each private CLI fixture and return its local reference. */
export function writeLegacyWebQuestions(root, blueprint) {
  const name = 'legacy-web-app.json';
  writeFileSync(join(root, name), JSON.stringify(legacyWebQuestions(blueprint)));
  return name;
}
