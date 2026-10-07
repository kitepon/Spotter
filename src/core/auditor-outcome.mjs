// Decides how one auditor outcome reaches the runtime error store. A single failure to reach
// or be served by the external backend is a handled, self-retrying condition: Spotter shows the
// fixed notice, keeps the parent turn and the user's input, and audits again on the next turn.
// It stays in the hook-event and daemon logs. It is registered only when it does not recover.

export const AUDITOR_AVAILABILITY_BACKENDS = new Set(['jev', 'haiku', 'codex-cli', 'unknown']);

// The code picks only when to register. It does not say whether the product or the
// environment is at fault: a timeout or a rejected login can be either.
const AUDITOR_BACKEND_ACCESS_CODES = new Set([
  'E_JEV_NETWORK', 'E_JEV_TIMEOUT', 'E_JEV_AUTH', 'E_JEV_USAGE_LIMIT',
  'E_CODEX_CLI_TIMEOUT', 'E_CODEX_CLI_AUTH', 'E_CODEX_CLI_USAGE_LIMIT',
  'E_HAIKU_TIMEOUT',
]);

// 'immediate' keeps the registration on every occurrence. 'on_unrecovered' is registered
// only when the failure streak outlives the recovery window without a successful audit.
export function auditorFailureLane(error) {
  const code = error?.code;
  if (AUDITOR_BACKEND_ACCESS_CODES.has(code)) return 'on_unrecovered';
  const status = error?.diagnostics?.status;
  if (code === 'E_JEV_HTTP' && Number.isSafeInteger(status) && status >= 500) return 'on_unrecovered';
  return 'immediate';
}

export function auditorAvailabilityBackend(value) {
  return AUDITOR_AVAILABILITY_BACKENDS.has(value) ? value : 'unknown';
}

export async function reportAuditorFailure(error, {
  runtimeErrorObserver, auditorAvailabilityObserver, backend,
}) {
  try {
    if (auditorFailureLane(error) === 'immediate') {
      await runtimeErrorObserver('auditor_unavailable');
      return;
    }
    await auditorAvailabilityObserver({
      outcome: 'failure', backend: auditorAvailabilityBackend(error?.backend ?? backend),
    });
  } catch {
    // Runtime error telemetry must not alter hook output, exit behavior or daemon state.
  }
}

// A judgment produced without contacting the backend proves nothing about its availability.
export async function reportAuditorSuccess(judgment, { auditorAvailabilityObserver, backend }) {
  if (judgment?.meta?.mode === 'empty_catalog') return;
  try {
    await auditorAvailabilityObserver({
      outcome: 'success', backend: auditorAvailabilityBackend(judgment?.meta?.backend ?? backend),
    });
  } catch {
    // Same telemetry safety boundary as reportAuditorFailure.
  }
}
