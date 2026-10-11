// Search by meaning: what the installer installs, who gets it, and what it
// trims afterwards. Pure helpers, kept out of bin/klypix-install.mjs because
// that file runs the install the moment it is imported.
//
// Measured 2026-10-11 on a clean npm cache: ~150 MB download, ~20 s on a fast
// line. Pruning what Node never loads (onnxruntime-web, other platforms' and
// architectures' native binaries) leaves ~110 MB on disk instead of ~390 MB,
// with the same answers and memory (load + 50 questions checked on the pruned
// tree). The gain, on the real 102-question set: the right card in the top 5
// for 54 questions with it, 19 without.
import fs from 'fs';
import path from 'path';

// Same pins as the desktop app's electron/semanticInstaller.ts: an owned npm
// tree, so a vulnerable sharp can never be resolved independently.
export const SEMANTIC_RUNTIME_MANIFEST = Object.freeze({
  name: 'klypix-semantic-runtime',
  private: true,
  version: '1.0.0',
  dependencies: { '@huggingface/transformers': '4.2.0', sharp: '0.35.5' },
  overrides: {
    '@huggingface/transformers': { sharp: '$sharp' },
    'onnxruntime-node': { 'adm-zip': '0.6.1' },
    'onnxruntime-web': { protobufjs: '7.6.5' },
  },
});

// Who gets it. A person at a terminal gets it unless they opt out; anything
// without a terminal (CI, scripts, an agent running the install, the test
// suite) only when it asks with --semantic. Plugin mode never: the Claude
// plugin runs only its pinned package and downloads no models.
export function semanticInstallDecision({ optOut, flag, runtimeOnly, plugin, present, ci, tty }) {
  if (plugin) return 'skip-plugin';
  if (optOut) return 'skip-optout';
  if (present) return 'present';
  if (flag) return 'install';
  if (runtimeOnly) return 'skip-runtime-only';
  if (ci) return 'skip-ci';
  if (!tty) return 'skip-noninteractive';
  return 'install';
}

export function dirBytes(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(p);
    else { try { total += fs.statSync(p).size; } catch { /* gone */ } }
  }
  return total;
}

// Remove what Node never loads. Touches only <semanticDir>/node_modules, and
// never removes the running platform's binary for the running architecture
// (a tree without it is left alone rather than pruned to nothing).
export function pruneSemanticRuntime(semanticDir, platform = process.platform, arch = process.arch) {
  const nm = path.join(semanticDir, 'node_modules');
  let freed = 0;
  const drop = (p) => {
    try { fs.statSync(p); } catch { return; }
    freed += dirBytes(p);
    fs.rmSync(p, { recursive: true, force: true });
  };
  drop(path.join(nm, 'onnxruntime-web'));
  const binRoot = path.join(nm, 'onnxruntime-node', 'bin');
  let napis = [];
  try { napis = fs.readdirSync(binRoot); } catch { /* none */ }
  for (const napi of napis) {
    let platforms = [];
    try { platforms = fs.readdirSync(path.join(binRoot, napi)); } catch { continue; }
    if (!platforms.includes(platform)) continue;
    for (const plat of platforms) {
      const platDir = path.join(binRoot, napi, plat);
      if (plat !== platform) { drop(platDir); continue; }
      let arches = [];
      try { arches = fs.readdirSync(platDir); } catch { continue; }
      if (!arches.includes(arch)) continue;
      for (const a of arches) if (a !== arch) drop(path.join(platDir, a));
    }
  }
  return freed;
}
