#!/usr/bin/env node
// Thin bin for `klypix-mcp pr-brief` — the worker dispatcher splices the verb out
// of argv before importing, so this bin re-supplies it. Standalone use works
// identically: node bin/klypix-pr-brief.mjs <args>
import { run } from './klypix-git-tools.mjs';
await run('pr-brief', process.argv.slice(2));
