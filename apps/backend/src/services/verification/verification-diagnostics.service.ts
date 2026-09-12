const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STAGES = new Set([
    'started',
    'callback_received',
    'token_validated',
    'education_response',
    'policy_decision',
    'finished',
]);
const OUTCOMES = new Set(['success', 'failure', 'unknown']);
const REASONS = new Set([
    'none',
    'permission_required',
    'invalid_identity',
    'missing_data',
    'upstream_unavailable',
    'policy_denied',
    'expired',
    'cancelled',
]);

export type DiagnosticEvent = {
    correlationId: string;
    stage: 'started' | 'callback_received' | 'token_validated' | 'education_response' | 'policy_decision' | 'finished';
    outcome: 'success' | 'failure' | 'unknown';
    reason: 'none' | 'permission_required' | 'invalid_identity' | 'missing_data' | 'upstream_unavailable' | 'policy_denied' | 'expired' | 'cancelled';
    httpStatus?: number;
    durationMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidDiagnosticEvent(): never {
    // Do not include a rejected value here: callers may pass provider tokens or errors.
    throw new TypeError('Invalid diagnostic event');
}

/** Produces a secret-free diagnostic line from the fixed event allowlist. */
export function serializeDiagnostic(event: unknown): string {
    if (!isRecord(event)) invalidDiagnosticEvent();

    try {
        const { correlationId, stage, outcome, reason, httpStatus, durationMs } = event;
        if (typeof correlationId !== 'string' || !UUID.test(correlationId)
            || typeof stage !== 'string' || !STAGES.has(stage)
            || typeof outcome !== 'string' || !OUTCOMES.has(outcome)
            || typeof reason !== 'string' || !REASONS.has(reason)
            || typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0
            || (httpStatus !== undefined && (typeof httpStatus !== 'number' || !Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599))) {
            invalidDiagnosticEvent();
        }

        const diagnostic: DiagnosticEvent = {
            correlationId,
            stage: stage as DiagnosticEvent['stage'],
            outcome: outcome as DiagnosticEvent['outcome'],
            reason: reason as DiagnosticEvent['reason'],
            durationMs,
            ...(httpStatus === undefined ? {} : { httpStatus }),
        };
        return JSON.stringify(diagnostic);
    } catch (error) {
        if (error instanceof TypeError && error.message === 'Invalid diagnostic event') throw error;
        invalidDiagnosticEvent();
    }
}
