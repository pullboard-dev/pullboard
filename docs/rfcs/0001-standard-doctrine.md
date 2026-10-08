# RFC 0001: A standard doctrine, version 1

- Status: accepted, 7 October 2026
- Proposed: 7 October 2026, by Corey Olson

## Summary

Pullboard ships a small standard doctrine that every repo inherits: twelve rules nearly every engineer agrees on, whatever the language, team size or workflow. A repo's `DOCTRINE.md` holds only its own rules: it adds to the standard, overrides a rule, or declines one with a reason. A legacy `PRACTICE.md` remains a compatibility fallback.

## Motivation

At the time of this RFC, `pullboard init` copied a 26-rule `PRACTICE.md` into each repo, and the copy never changed again. Those copies drifted: Pullboard's own file had drifted from the template, and two reused ids for different rules. One standard that every repo inherits stays one thing, improves for everyone at once, and can be discussed in one place.

## The standard, version 1

The rules use the spec row format. Their ids start with PB and are never reused.

- PB1 [approved, must] Ask, don't guess: a decision only the person can make waits for them. | gate: review
- PB2 [approved, must] Destructive or irreversible actions wait for the person's OK. | gate: review
- PB3 [approved, must] Claims come with evidence: say what ran and what it showed, never "should work". | gate: review
- PB4 [approved, must] A test must be able to fail: see it fail on broken code before trusting it. | gate: review
- PB5 [approved, must] Never weaken a test or a check to make it pass; fix the code. | gate: review
- PB6 [approved, must] Tests pass before a change merges. | gate: the project's gate
- PB7 [pending, aim] Tests touch nothing outside a temporary sandbox. | gate: review
- PB8 [approved, must] No secrets or sensitive info in the repo; test data is synthetic. | gate: review
- PB9 [approved, must] Headers: type(scope): subject [ids], 72 characters at most. A body only for a non-obvious why, three sentences at most. | gate: commit-msg hook, review
- PB10 [approved, must] Comments explain why, not what; no commented-out code. | gate: review
- PB11 [approved, must] A new dependency states why it is needed and what it pulls in. | gate: review
- PB12 [approved, must] Questions go on the board, one step up the chain, and the asker keeps working on what it can meanwhile. | gate: review

## What is left out, and why

- Rules that come with a Pullboard feature: a second agent verifies, work stays in its lane, commits and tests cite spec rows. They switch on when a repo uses the feature.
- Size, complexity and language rules. They vary by project, so each repo adds its own.

## How a repo uses it

Every repo inherits all of it. Its `DOCTRINE.md` adds rules with its own ids, overrides a standard rule by repeating its PB id with new text, or declines one with a wont row naming the PB id and the reason. A legacy `PRACTICE.md` remains a compatibility fallback. Agents and the view see the merged set, each rule marked as the standard's, with its version, or the repo's.

## How the standard changes

By RFC, as described in [README.md](README.md). An accepted change bumps the version: a new or relaxed rule is a minor version, and a stricter rule or a changed meaning is a major one. `pullboard practice` shows each repo what changed since it last looked.

## Open questions

- PB7: is "nothing outside a temporary sandbox" universal? Integration tests against local services may need more room.
