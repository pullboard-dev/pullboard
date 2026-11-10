#!/usr/bin/env node
/**
 * Runs the static tree registry on a checkout and prints its failures as one JSON list.
 * Why: the CLI preflight runs it as a process, so it needs no import past gate's front doors [C7].
 */
import { runStaticTreeRegistry } from '../src/io/static/registry.js';

process.stdout.write(JSON.stringify(runStaticTreeRegistry(process.argv[2] ?? process.cwd())));
