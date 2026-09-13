import type { Pool } from 'pg';
import { appLogger } from '../../common/logger.js';

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

export type DiagnosticStorageContext = {
    institutionId: string;
    policyVersion: number;
};

export interface VerificationDiagnostics {
    record(context: DiagnosticStorageContext, event: unknown): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidDiagnosticEvent(): never {
    // Do not include a rejected value here: callers may pass provider tokens or errors.
    throw new TypeError('Invalid diagnostic event');
}

/** Produces a secret-free diagnostic line from the fixed event allowlist. */
export function serializeDiagnostic(event: unknown): string {
    try {
        if (!isRecord(event)) invalidDiagnosticEvent();
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
    } catch {
        invalidDiagnosticEvent();
    }
}

function validStorageContext(context: DiagnosticStorageContext): boolean {
    return UUID.test(context.institutionId)
        && Number.isInteger(context.policyVersion)
        && context.policyVersion >= 1;
}

/**
 * Persists the fixed diagnostic allowlist. The caller supplies only server-side
 * institution metadata captured on the durable verification attempt.
 */
export class VerificationDiagnosticsService implements VerificationDiagnostics {
    constructor(private readonly pool: Pick<Pool, 'connect'>) {}

    async record(context: DiagnosticStorageContext, event: unknown): Promise<void> {
        if (!validStorageContext(context)) throw new TypeError('Invalid diagnostic context');
        const diagnostic = JSON.parse(serializeDiagnostic(event)) as DiagnosticEvent;
        // This writer is entered only after an authority transaction resolves.
        // Lock the institution before the attempt FK is checked, matching the
        // canonical authority order and avoiding an inverse FK lock deadlock.
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const institution = await client.query(
                'SELECT id FROM universities WHERE id=$1 FOR KEY SHARE',
                [context.institutionId],
            );
            if (institution.rowCount !== 1) throw new TypeError('Invalid diagnostic context');
            await client.query(
                `INSERT INTO verification_diagnostic_events
                     (correlation_id, stage, outcome, reason, http_status, duration_ms, institution_id, policy_version)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    diagnostic.correlationId, diagnostic.stage, diagnostic.outcome, diagnostic.reason,
                    diagnostic.httpStatus ?? null, diagnostic.durationMs,
                    context.institutionId, context.policyVersion,
                ],
            );
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }
}

/**
 * Diagnostics are intentionally non-authoritative. A storage failure is kept
 * out of provider and authority logs and cannot change a committed outcome.
 */
export async function recordDiagnosticBestEffort(
    diagnostics: VerificationDiagnostics,
    context: DiagnosticStorageContext,
    event: unknown,
    alert: (...args: unknown[]) => void = appLogger.error,
): Promise<void> {
    try {
        await diagnostics.record(context, event);
    } catch {
        alert('verification diagnostic persistence failed');
    }
}
