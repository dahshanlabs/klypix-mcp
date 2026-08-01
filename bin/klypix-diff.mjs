#!/usr/bin/env node
// Thin bin for `klypix-mcp diff` — the worker dispatcher splices the verb out
// of argv before importing, so this bin re-supplies it. Standalone use works
// identically: node bin/klypix-diff.mjs <args>
import { run } from './klypix-git-tools.mjs';
await run('diff', process.argv.slice(2));
