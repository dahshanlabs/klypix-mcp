// MCP Agent Mail (the maintained Rust rewrite, github.com/Dicklesworthstone/mcp_agent_mail_rust)
// as a coordination-bench condition — ADAPTER SKELETON, runnable:false.
//
// Status (2026-11-08, Windows 11 x64): the project's latest release, v0.3.40
// (2026-11-01), ships `mcp-agent-mail-x86_64-pc-windows-msvc.zip`, so the
// brief's "Linux/macOS binaries only" is out of date; its own release notes
// say "Native Windows is unverified". What WAS verified here: the zip's SHA-256
// matched its published `.sha256`; `am.exe serve-stdio` (the stdio entry — the
// `mcp-agent-mail.exe` default is HTTP + TUI) starts when `STORAGE_ROOT` names
// an EXISTING directory (it refuses to create it), answers `initialize` with
// protocol 2024-11-05 in ~5–11 s, and lists 45 tools: health_check,
// ensure_project, register_agent, create_agent_identity, retire_agent,
// unretire_agent, deregister_agent, whois, resolve_pane_identity,
// cleanup_pane_identities, list_agents, send_message, reply_message,
// fetch_inbox, fetch_topic, fetch_inbox_events, mark_message_read,
// mark_all_read, acknowledge_message, get_message_delivery_receipt,
// request_contact, respond_contact, list_contacts, set_contact_policy,
// check_file_reservation_conflicts, file_reservation_paths,
// release_file_reservations, renew_file_reservations,
// force_release_file_reservation, install_precommit_guard,
// uninstall_precommit_guard, search_messages, summarize_thread,
// macro_start_session, macro_prepare_thread, macro_file_reservation_cycle,
// macro_contact_handshake, ensure_product, products_link,
// search_messages_product, fetch_inbox_product, summarize_thread_product,
// acquire_build_slot, renew_build_slot, release_build_slot. Required inputs
// from that listing: register_agent(project_key, program, model);
// file_reservation_paths(project_key, agent_name, paths); send_message
// (project_key, sender_name, to, subject, body_md); fetch_inbox(project_key,
// agent_name). Nothing beyond `tools/list` was called; the condition stays
// runnable:false until the mapping below has been run against the server —
// nothing here has produced a number, and nothing is simulated.
//
// The open question the verification has to settle: Agent Mail routes
// messages to NAMED mailboxes (`send_message(to: [name])`; broadcast is
// rejected) and an agent under test has no name until it calls
// `register_agent` itself. A note from a session that has ended (S3) therefore
// has no addressee at write time. Candidates to measure, each a different
// claim about the product: a thread the agent is told to read
// (`fetch_topic` / `thread_id`), `search_messages`, or a pre-created identity
// the agent is told to reuse (`register_agent(name)`). Whichever is chosen
// must be documented as the condition's reading of the product, as the
// Concord module documents its review-ready reading.
//
// Documented tool mapping the finished adapter is expected to use (names from
// the v0.3.40 README; parameters unverified against a live server):
//   ensure_project(human_key=<abs repo path>)                    once per run
//   register_agent(project_key, name=<actor id>, program=<client>, model=<required>)
//   file_reservation_paths(project_key, agent_name, paths=actor.files,
//                          exclusive=true, ttl_seconds=...)       S2, S10 (a live peer)
//   send_message(project_key, sender_name, to=[...], subject, body_md,
//                thread_id, ack_required=false)                   a decision / finding (S1, S3, S4, S8; S6 mid-task)
//   fetch_inbox(project_key, agent_name) / search_messages        read-back of delivery
//   release_file_reservations(...) / an expired ttl                an ENDED session's claim (S5-family, S9)
// An ended session's reservation should be left to the product's own expiry
// (ttl) the way the KLYPIX and Concord conditions leave an ended row to the
// product's presence rules; the bench must not release it by hand.
//
// Transport: the binary speaks stdio MCP by default (`mcp-agent-mail`), HTTP
// through `mcp-agent-mail serve` / `am serve-http` (bearer token optional on
// loopback). State: `STORAGE_ROOT` (SQLite at <STORAGE_ROOT>/storage.sqlite3,
// a git mailbox archive under the XDG data dir) — pin it inside the run's
// throwaway home, as the other conditions pin theirs.
import fs from 'node:fs';

export const AGENT_MAIL_PINNED_VERSION = '0.3.40';
/** Path to a verified `mcp-agent-mail` binary; unset on every machine until the adapter is verified. */
export const AGENT_MAIL_BIN_ENV = 'KLYPIX_BENCH_AGENT_MAIL_BIN';
export const AGENT_MAIL_WINDOWS_ASSET = 'mcp-agent-mail-x86_64-pc-windows-msvc.zip';

/** What this machine has, stated precisely — never a reason to run. */
export function agentMailStatus(env = process.env, platform = process.platform) {
  const bin = env[AGENT_MAIL_BIN_ENV];
  const present = !!bin && fs.existsSync(bin);
  const asset = platform === 'win32' ? `a Windows x64 release asset exists (${AGENT_MAIL_WINDOWS_ASSET}, v${AGENT_MAIL_PINNED_VERSION}; the project calls native Windows unverified)` : `release binaries exist for this platform (v${AGENT_MAIL_PINNED_VERSION})`;
  return {
    binary: present ? bin : null,
    reason: `${present ? `binary at ${bin}` : `no verified binary on PATH (${AGENT_MAIL_BIN_ENV} unset)`}; ${asset}; the adapter (register_agent, file_reservation_paths, send_message, fetch_inbox) is a skeleton that has not been verified against the running server, and how a note reaches an agent that has not yet registered a mailbox name is unsettled — no number is published until both are`,
  };
}

/**
 * The actor's calls for a scenario, as the finished adapter would issue them.
 * Pure: a plan to verify against the server, not a run. `recipient` is the
 * unsettled part (see the file header) and is left null on purpose.
 */
export function agentMailPlan(scenario, { repoDir, actorName = null, recipient = null } = {}) {
  const actor = scenario.actor || {};
  const name = actorName || actor.id || 'other-session';
  const program = typeof actor.clientFor === 'function' ? actor.clientFor(null) : (actor.client || 'claude-code');
  const calls = [
    { tool: 'ensure_project', args: { human_key: repoDir } },
    { tool: 'register_agent', args: { project_key: repoDir, name, program, model: 'unknown' } },
  ];
  if (actor.files && actor.files.length && !actor.closed) {
    calls.push({ tool: 'file_reservation_paths', args: { project_key: repoDir, agent_name: name, paths: actor.files, exclusive: true, ttl_seconds: 3600 } });
  }
  for (const f of (scenario.facts || []).filter((x) => x.text != null && !x.klypixVia)) {
    calls.push({ tool: 'send_message', args: { project_key: repoDir, sender_name: name, to: recipient ? [recipient] : null, subject: (actor.intent || 'Note').slice(0, 80), body_md: f.text, thread_id: `bench-${f.id}`, ack_required: false }, unsettled: recipient ? null : 'recipient: the agent under test has no mailbox name before it registers' });
  }
  return calls;
}

export const agentMail = {
  id: 'agent-mail',
  label: `MCP Agent Mail (Rust rewrite, pinned ${AGENT_MAIL_PINNED_VERSION})`,
  mcp: true,
  runnable: false,
  get reason() { return agentMailStatus().reason; },
  serverInfo() { const s = agentMailStatus(); return { name: 'agent-mail', version: null, pinned: AGENT_MAIL_PINNED_VERSION, binary: s.binary, ok: false }; },
  async prepare() { throw new Error(`agent-mail is not runnable: ${agentMailStatus().reason}`); },
  async later() { throw new Error('agent-mail is not runnable'); },
};
