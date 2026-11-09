// Benchmark credential transport. A local helper owns DPAPI storage and a
// current-user-only Windows pipe; this module never writes credentials.
import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { StringDecoder } from 'node:string_decoder';

const authentic = new WeakSet();
const REDACTED = '[REDACTED_API_KEY]';
// Hold a possible partial credential across chunks before emitting any bytes.
// This function is also embedded in the native observer accounting proxy.
export function createCredentialRedactor(secret) {
  const decoder = new StringDecoder('utf8'); let pending = '';
  const replace = value => secret ? value.replaceAll(secret, '[REDACTED_API_KEY]') : value;
  return {
    write(chunk) {
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (!secret) { const output = pending; pending = ''; return output; }
      pending = replace(pending);
      // Retain only an actual prefix of the secret. Holding an arbitrary tail
      // would delay a complete result frame and deadlock the interactive SDK.
      let keep = Math.min(secret.length - 1, pending.length);
      while (keep && !secret.startsWith(pending.slice(-keep))) keep--;
      const cut = pending.length - keep;
      const output = pending.slice(0, cut); pending = pending.slice(cut); return output;
    },
    end() { pending += decoder.end(); const output = replace(pending); pending = ''; return output; },
  };
}
export const authenticationMetadata = auth => {
  if (!auth) return { method: 'subscription', transport: 'isolated OAuth credential copy' };
  if (!authentic.has(auth)) throw new Error('Authentication must come from the explicit benchmark credential loader');
  return { method: auth.method, transport: auth.transport };
};

export async function loadBenchmarkAuthentication({ method = 'subscription', apiKeyPipe = null,
  platform = process.platform, readPipe = (file, options) => fs.promises.readFile(file, options) } = {}) {
  if (!['subscription', 'api-key'].includes(method)) throw new Error('Unsupported benchmark authentication method');
  if (method === 'subscription') {
    if (apiKeyPipe) throw new Error('An API credential pipe requires explicit api-key mode');
    return null;
  }
  if (platform !== 'win32' || typeof apiKeyPipe !== 'string' || !/^\\\\\.\\pipe\\[A-Za-z0-9_.-]+$/.test(apiKeyPipe)) {
    throw new Error('API-key mode requires an explicit Windows named pipe; plaintext credential files are not supported');
  }
  let content;
  try { content = await readPipe(apiKeyPipe, { encoding: 'utf8', signal: AbortSignal.timeout(5000) }); }
  catch { throw new Error('Secure API credential pipe could not be read; no fallback authentication is allowed'); }
  if (typeof content !== 'string' || content.length > 16_384) throw new Error('Invalid secure credential payload');
  let parsed;
  try { parsed = parseEnv(content); } catch { throw new Error('Invalid secure credential payload'); }
  let key = parsed.ANTHROPIC_API_KEY;
  if (Object.keys(parsed).length !== 1 || typeof key !== 'string' || !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) {
    throw new Error('Secure credential payload must contain only a valid Anthropic API key');
  }
  content = ''; parsed = null;
  const requireKey = () => { if (!key) throw new Error('Benchmark credentials have been disposed'); return key; };
  const auth = Object.freeze({
    method: 'api-key', transport: 'DPAPI at rest; current-user Windows named pipe; spawn-only environment', envFile: apiKeyPipe,
    applySpawnEnv(env) {
      const next = { ...env, ANTHROPIC_API_KEY: requireKey() };
      delete next.CLAUDE_CODE_OAUTH_TOKEN; delete next.ANTHROPIC_AUTH_TOKEN;
      return next;
    },
    redact(text) { return String(text).replaceAll(requireKey(), REDACTED); },
    assertPublic(value) {
      if (JSON.stringify(value)?.includes(requireKey())) throw new Error('Credential would enter a public benchmark artifact; refusing');
    },
    streamRedactor() { return createCredentialRedactor(requireKey()); },
    dispose() { key = ''; },
    toJSON() { return { method: 'api-key', transport: 'current-user Windows named pipe' }; },
  });
  authentic.add(auth);
  return auth;
}

export function spawnEnvironment(env, authentication) {
  authenticationMetadata(authentication);
  return authentication ? authentication.applySpawnEnv(env) : env;
}

// Native passive hooks run in the foreground CLI's environment. Redact only
// the explicitly supplied API credential before persisting tool receipts.
export function redactProcessCredential(text, env = process.env) {
  const key = env.ANTHROPIC_API_KEY;
  return typeof key === 'string' && key.length >= 20 ? String(text).replaceAll(key, '[REDACTED_API_KEY]') : String(text);
}
