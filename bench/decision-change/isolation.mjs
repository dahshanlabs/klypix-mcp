import path from 'node:path';

// Keep executable lookup/system plumbing, but never inherit another host's
// authentication, project routing, bridge, profile or session identity.
export function freshEnvironment(home, source = process.env) {
  if (!path.isAbsolute(home)) throw new Error('Isolated home must be absolute');
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || /^(?:CLAUDE|ANTHROPIC|CODEX|OPENAI|GEMINI|GOOGLE|SUPERMEMORY|KLYPIX|CMEM|BUN_|XDG_|AWS_)/i.test(key)
      || /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD)(?:_|$)/i.test(key)
      || /^(?:npm_config_|NPM_CONFIG_|GIT_)/.test(key) || /^(?:NODE_OPTIONS|NODE_PATH)$/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'), APPDATA: path.join(home, 'AppData/Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData/Local'), XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
    HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(path.parse(home).root.length - 1),
    TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'), TMPDIR: path.join(home, 'tmp'),
    npm_config_cache: path.join(home, '.npm'), npm_config_prefix: path.join(home, '.npm-global'),
    NPM_CONFIG_USERCONFIG: path.join(home, 'empty.npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(home, 'empty-global.npmrc'),
    GIT_CONFIG_GLOBAL: path.join(home, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    DISABLE_AUTOUPDATER: '1', DO_NOT_TRACK: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}
