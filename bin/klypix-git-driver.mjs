#!/usr/bin/env node
// Thin bin for `klypix-mcp git-driver` — the worker dispatcher splices the verb out
// of argv before importing, so this bin re-supplies it. Standalone use works
// identically: node bin/klypix-git-driver.mjs <args>
import { run } from './klypix-git-tools.mjs';
await run('git-driver', process.argv.slice(2));
