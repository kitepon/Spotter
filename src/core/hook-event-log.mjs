// Phase D (hook parity, 2026-05-08): host-neutral hook-event JSONL log.
//
// Codex side previously wrote `.spotter/codex-hook-events.jsonl` with schema
// `spotter.codex_hook_event.v1`. v1.4.8 unifies that into `.spotter/hook-events.jsonl`
// with schema `spotter.hook_event.v1` + a `host` field, and Claude hooks now write to
// the same file. Records every hook firing with skip / success / error / finding status
// so `spotter diagnostics logs` can surface hook-side observations the daemon log alone
// never sees (short-prompt skip, legacy pending discard diagnostics, hook-level transport errors).
//
// File path: `<projectRoot>/.spotter/hook-events.jsonl` (append-only; replaced into `.1` once it passes
// HOOK_EVENTS_MAX_BYTES, so a project keeps at most the current file plus one generation).
// Record schema (v1):
//   {
//     schema: "spotter.hook_event.v1",
//     timestamp: "<ISO 8601 UTC>",
//     host: "claude" | "codex",
//     hook: "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "Stop" | "SessionEnd",
//     status: <hook-specific string>,
//     backend?: "jev" | "haiku" | "codex-cli" | null,
//     pass?: boolean | null,
//     missingTools?: string[],
//     code?: string | null,
//     reason?: string | null,
//     durationMs?: number,
//     backendDurationMs?: number | null,
//     usedToolCount?: number,
//     legacyPendingDiagnostic?: string | null,
//     toolName?: string | null,
//     internalCode?: string | null,   // failing step's own code; `code` is the projected one
//     causeCode?: string,
//     causeExitCode?: number,
//     runtimeErrorRegistration?: "collected" | <fixed reason such as "store_unavailable">
//   }

import { appendFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const HOOK_EVENTS_FILE = 'hook-events.jsonl';
export const HOOK_EVENTS_MAX_BYTES = 2 * 1024 * 1024;
export const HOOK_EVENT_SCHEMA = 'spotter.hook_event.v1';
export const HOOK_EVENTS_SUMMARY_SCHEMA = 'spotter.hook_events_summary.v1';

const EVENT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function eventCode(value) {
  return typeof value === 'string' && EVENT_CODE_PATTERN.test(value) ? value : null;
}

// `code` holds the projected, user-facing code, which folds many failures into one generic value.
// These fields keep the failing step's own code so a single failure can be read back from the log.
// Only fixed identifiers and an exit status are taken; messages and provider output never are.
export function failureEventFields(error) {
  const fields = { internalCode: eventCode(error?.code) };
  const causeCode = eventCode(error?.cause?.code);
  if (causeCode !== null) fields.causeCode = causeCode;
  if (Number.isInteger(error?.cause?.exitCode)) fields.causeExitCode = error.cause.exitCode;
  return fields;
}

// Whether the immediate-lane runtime error registration reached the store. Without it a dropped
// registration leaves no trace in this log. Only a fixed snake_case reason is taken.
const REGISTRATION_OUTCOME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function registrationEventFields(reported) {
  const outcome = reported?.runtimeErrorRegistration;
  return typeof outcome === 'string' && REGISTRATION_OUTCOME_PATTERN.test(outcome)
    ? { runtimeErrorRegistration: outcome }
    : {};
}

export function hookEventsPath(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('hookEventsPath: projectRoot must be a non-empty string');
  }
  return join(projectRoot, '.spotter', HOOK_EVENTS_FILE);
}

export async function appendHookEvent({ projectRoot, host, event, maxBytes } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('appendHookEvent: projectRoot must be a non-empty string');
  }
  if (!['claude', 'codex', 'grok'].includes(host)) {
    throw new TypeError(`appendHookEvent: host must be "claude", "codex", or "grok" (got ${String(host)})`);
  }
  if (!event || typeof event !== 'object') {
    throw new TypeError('appendHookEvent: event must be an object');
  }
  const value = {
    schema: HOOK_EVENT_SCHEMA,
    timestamp: new Date().toISOString(),
    host,
    ...event,
  };
  const path = hookEventsPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await rotateHookEvents(path, maxBytes);
  await appendFile(path, JSON.stringify(value) + '\n', 'utf8');
}

// Rotation is best effort and never stops the append. Every hook process runs stat -> rename ->
// append, so a short-lived lock file lets one process rotate while the others skip; the winner
// checks the size again under the lock, so a rotation that just happened is not repeated and the
// fresh file is not moved over the generation. A lost race, a held or unremovable lock, or a Windows
// sharing violation leaves the file over the cap until a later event. A line is appended whole, so a
// single event larger than the cap, or writers racing past the check, can exceed it.
// Hook events are diagnostics, not records to keep: do not rely on the two generations as an archive.
const ROTATE_LOCK_STALE_MS = 10_000;

async function rotateHookEvents(path, maxBytes = HOOK_EVENTS_MAX_BYTES) {
  const lockPath = `${path}.lock`;
  try {
    if ((await stat(path)).size <= maxBytes) return;
    let lock;
    try {
      lock = await open(lockPath, 'wx');
    } catch {
      // A lock left by a crashed process would block rotation forever; drop it once it is old.
      const held = await stat(lockPath).catch(() => null);
      if (held && Date.now() - held.mtimeMs > ROTATE_LOCK_STALE_MS) await unlink(lockPath).catch(() => {});
      return;
    }
    try {
      if ((await stat(path)).size > maxBytes) await rename(path, `${path}.1`);
    } finally {
      await lock.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    }
  } catch {
    // best effort
  }
}

export async function appendHookEventSafe({ projectRoot, host, event, writeError } = {}) {
  try {
    await appendHookEvent({ projectRoot, host, event });
  } catch (err) {
    if (typeof writeError === 'function') {
      writeError(`spotter hook-event log failed: ${err.message}\n`);
    }
  }
}

export async function summarizeHookEvents({ projectRoot, readFileFn = readFile } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('summarizeHookEvents: projectRoot must be a non-empty string');
  }
  const summary = {
    schema: HOOK_EVENTS_SUMMARY_SCHEMA,
    projectRoot,
    logPath: hookEventsPath(projectRoot),
    exists: false,
    // Counts cover the current file only; these keep a rotated file from being read as the whole history.
    firstTimestamp: null,
    previousGeneration: false,
    events: 0,
    parseErrors: 0,
    byHost: {},
    byHook: {},
    byStatus: {},
    byBackend: {},
    averageDurationMs: 0,
    maxDurationMs: 0,
    recent: [],
  };
  let totalDurationMs = 0;
  try {
    const raw = await readFileFn(summary.logPath, 'utf8');
    summary.exists = true;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        summary.parseErrors += 1;
        continue;
      }
      summary.events += 1;
      summary.firstTimestamp ??= typeof event.timestamp === 'string' ? event.timestamp : null;
      bump(summary.byHost, event.host ?? 'unknown');
      bump(summary.byHook, event.hook ?? 'unknown');
      bump(summary.byStatus, event.status ?? 'unknown');
      if (event.backend) bump(summary.byBackend, event.backend);
      if (Number.isFinite(event.durationMs)) {
        totalDurationMs += event.durationMs;
        summary.maxDurationMs = Math.max(summary.maxDurationMs, event.durationMs);
      }
      summary.recent.push(compactHookEvent(event));
      if (summary.recent.length > 5) summary.recent.shift();
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  summary.previousGeneration = await stat(`${summary.logPath}.1`).then(() => true, () => false);
  summary.averageDurationMs = summary.events > 0 ? Math.round(totalDurationMs / summary.events) : 0;
  return summary;
}

function compactHookEvent(event) {
  return {
    timestamp: event.timestamp ?? null,
    host: event.host ?? null,
    hook: event.hook ?? 'unknown',
    status: event.status ?? 'unknown',
    backend: event.backend ?? null,
    pass: typeof event.pass === 'boolean' ? event.pass : null,
    missingTools: Array.isArray(event.missingTools) ? event.missingTools : [],
    code: event.code ?? null,
    reason: event.reason ?? null,
    durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
  };
}

function bump(counter, key) {
  counter[key] = (counter[key] ?? 0) + 1;
}
