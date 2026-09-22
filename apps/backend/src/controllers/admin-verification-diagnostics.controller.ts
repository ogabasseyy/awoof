import type { Request, Response } from 'express';
import { z } from 'zod';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import { db } from '../config/database.js';

const correlationIdSchema = z.string().uuid();
const attemptIdSchema = z.string().uuid();

const stages = ['started', 'callback_received', 'token_validated', 'education_response', 'policy_decision', 'finished'] as const;
const outcomes = ['success', 'failure', 'unknown'] as const;
const reasons = ['none', 'permission_required', 'invalid_identity', 'missing_data', 'upstream_unavailable', 'policy_denied', 'expired', 'cancelled'] as const;

type Stage = typeof stages[number];
type Outcome = typeof outcomes[number];
type Reason = typeof reasons[number];

type TimelineRow = {
    stage: Stage;
    outcome: Outcome;
    reason: Reason;
    http_status: number | null;
    duration_ms: number;
    recorded_at: Date;
    institution_id: string;
};

type LatencyRow = {
    institution_id: string;
    institution_name: string;
    finished_attempt_count: string | number;
    average_finished_request_duration_ms: string | number | null;
    p95_finished_request_duration_ms: string | number | null;
};

type FailureRow = {
    institution_id: string;
    reason: Reason;
    event_count: string | number;
};

type IncompleteRow = {
    institution_id: string;
    incomplete_attempts: string | number;
};

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
    return typeof value === 'string' && values.includes(value as T[number]);
}

function finiteNumber(value: unknown): number | null {
    if (value === null || value === undefined || (typeof value !== 'number' && typeof value !== 'string')) return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function nonnegativeCount(value: unknown): number | null {
    const parsed = finiteNumber(value);
    return parsed !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function serializeTimeline(rows: TimelineRow[]) {
    return rows.flatMap((row) => {
        const durationMs = finiteNumber(row.duration_ms);
        if (!isOneOf(row.stage, stages) || !isOneOf(row.outcome, outcomes) || !isOneOf(row.reason, reasons)
            || durationMs === null || durationMs < 0 || !(row.recorded_at instanceof Date)) return [];
        const httpStatus = row.http_status === null ? null : finiteNumber(row.http_status);
        if (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) return [];
        return [{
            stage: row.stage,
            outcome: row.outcome,
            reason: row.reason,
            httpStatus,
            durationMs,
            recordedAt: row.recorded_at.toISOString(),
        }];
    });
}

/**
 * Reads a single redacted diagnostic timeline and a fixed 30-day aggregate.
 * No student, attempt, identity, tenant, URL, token or provider-response value
 * is selected by this controller.
 */
/**
 * Resolves a verification attempt to its diagnostic timeline through the
 * same authorized, audited path below. Operators otherwise cannot reach
 * the diagnostics surface from a production attempt without direct
 * database access: the start response exposes only the attempt ID.
 */
export async function readVerificationDiagnosticsByAttempt(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const attemptId = attemptIdSchema.parse(req.params.attemptId);
    const actorId = z.string().uuid().safeParse(req.user?.userId);
    if (!actorId.success) throw new UnauthorizedError('Authenticated administrator required');
    // The correlation is written once at attempt creation and never
    // updated, so a single indexed lookup suffices; the delegated read
    // re-verifies the administrator and records the same access audit.
    // Missing attempts and attempts without diagnostics stay a generic
    // absence: do not disclose whether an attempt exists.
    const attempt = await db.getPool().query<{ diagnostic_correlation_id: string | null }>(
        'SELECT diagnostic_correlation_id FROM microsoft_verification_attempts WHERE id = $1',
        [attemptId],
    );
    const correlationId = attempt.rows[0]?.diagnostic_correlation_id;
    if (!correlationId) throw new NotFoundError('Verification diagnostic not found');
    req.params.correlationId = correlationId;
    return readVerificationDiagnostics(req, res);
}

export async function readVerificationDiagnostics(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const correlationId = correlationIdSchema.parse(req.params.correlationId);
    const actorId = z.string().uuid().safeParse(req.user?.userId);
    if (!actorId.success) throw new UnauthorizedError('Authenticated administrator required');

    const tx = await db.getPool().connect();
    try {
        await tx.query('BEGIN');
        // The router guard is intentionally repeated within this transaction so
        // a demoted/deleted administrator cannot use a stale JWT to read data.
        const actor = await tx.query<{ role: string; deleted_at: Date | null }>(
            'SELECT role, deleted_at FROM users WHERE id = $1 FOR UPDATE', [actorId.data],
        );
        if (actor.rows[0]?.role !== 'admin' || actor.rows[0].deleted_at !== null) {
            throw new ForbiddenError('Current administrator authority required');
        }

        const timelineResult = await tx.query<TimelineRow>(
            `SELECT stage, outcome, reason, http_status, duration_ms, recorded_at, institution_id
             FROM verification_diagnostic_events
             WHERE correlation_id = $1
             ORDER BY recorded_at ASC, id ASC
             LIMIT 100`,
            [correlationId],
        );
        const timeline = serializeTimeline(timelineResult.rows);
        // Missing or invalid persisted rows remain a generic absence.  Do not
        // disclose whether a correlation was associated with a student.
        if (timeline.length === 0) throw new NotFoundError('Verification diagnostic not found');

        // The range is fixed by the 30-day diagnostic-retention contract; this
        // endpoint deliberately has no date, subject, or provider filters.
        const measuredAtResult = await tx.query<{ measured_at: Date }>('SELECT clock_timestamp() AS measured_at');
        const measuredAt = measuredAtResult.rows[0]?.measured_at;
        if (!(measuredAt instanceof Date)) throw new Error('Diagnostic clock unavailable');
        const latencies = await tx.query<LatencyRow>(
            `SELECT policy.university_id AS institution_id,
                    institution.name AS institution_name,
                    (COUNT(DISTINCT event.correlation_id) FILTER (WHERE event.stage = 'finished'))::integer AS finished_attempt_count,
                    AVG(event.duration_ms) FILTER (WHERE event.stage = 'finished') AS average_finished_request_duration_ms,
                    percentile_cont(0.95) WITHIN GROUP (ORDER BY event.duration_ms) FILTER (WHERE event.stage = 'finished') AS p95_finished_request_duration_ms
             FROM institution_microsoft_policies policy
             JOIN universities institution ON institution.id = policy.university_id
             LEFT JOIN verification_diagnostic_events event
               ON event.institution_id = policy.university_id
              AND event.recorded_at >= $1::timestamptz - interval '30 days'
              AND event.recorded_at <= $1::timestamptz
             GROUP BY policy.university_id, institution.name
             ORDER BY institution.name, policy.university_id`,
            [measuredAt],
        );
        const failures = await tx.query<FailureRow>(
            `SELECT event.institution_id, event.reason, COUNT(DISTINCT event.correlation_id)::integer AS event_count
             FROM verification_diagnostic_events event
             JOIN institution_microsoft_policies policy ON policy.university_id = event.institution_id
             WHERE event.recorded_at >= $1::timestamptz - interval '30 days'
               AND event.recorded_at <= $1::timestamptz
               AND event.outcome = 'failure'
             GROUP BY event.institution_id, event.reason
             ORDER BY event.institution_id, event.reason`,
            [measuredAt],
        );
        const incompletes = await tx.query<IncompleteRow>(
            `SELECT event.institution_id, COUNT(DISTINCT event.correlation_id)::integer AS incomplete_attempts
             FROM verification_diagnostic_events event
             JOIN institution_microsoft_policies policy ON policy.university_id = event.institution_id
             JOIN microsoft_verification_attempts attempt ON attempt.diagnostic_correlation_id = event.correlation_id
             WHERE event.recorded_at >= $1::timestamptz - interval '30 days'
               AND event.recorded_at <= $1::timestamptz
               AND event.stage = 'started'
               AND attempt.expires_at <= $1::timestamptz
               AND attempt.status <> 'completed'
               AND NOT EXISTS (
                   SELECT 1 FROM verification_diagnostic_events callback
                   WHERE callback.correlation_id = event.correlation_id
                     AND callback.stage = 'callback_received'
               )
               AND NOT EXISTS (
                   SELECT 1 FROM verification_diagnostic_events finished
                   WHERE finished.correlation_id = event.correlation_id
                     AND finished.stage = 'finished'
               )
             GROUP BY event.institution_id
             ORDER BY event.institution_id`,
            [measuredAt],
        );

        const aggregateByInstitution = new Map<string, {
            institutionId: string;
            institutionName: string;
            finishedAttemptCount: number;
            averageFinishedRequestDurationMs: number | null;
            p95FinishedRequestDurationMs: number | null;
            incompleteAttempts: number;
            failureCategories: Array<{ category: Reason; eventCount: number }>;
        }>();
        for (const row of latencies.rows) {
            const finishedAttemptCount = nonnegativeCount(row.finished_attempt_count);
            const averageFinishedRequestDurationMs = finiteNumber(row.average_finished_request_duration_ms);
            const p95FinishedRequestDurationMs = finiteNumber(row.p95_finished_request_duration_ms);
            const institutionName = z.string().trim().min(1).max(200).safeParse(row.institution_name);
            if (!z.string().uuid().safeParse(row.institution_id).success || !institutionName.success || finishedAttemptCount === null) continue;
            aggregateByInstitution.set(row.institution_id, {
                institutionId: row.institution_id,
                institutionName: institutionName.data,
                finishedAttemptCount,
                averageFinishedRequestDurationMs,
                p95FinishedRequestDurationMs,
                incompleteAttempts: 0,
                failureCategories: [],
            });
        }
        for (const row of failures.rows) {
            const aggregate = aggregateByInstitution.get(row.institution_id);
            const eventCount = nonnegativeCount(row.event_count);
            if (aggregate && isOneOf(row.reason, reasons) && eventCount !== null) {
                aggregate.failureCategories.push({ category: row.reason, eventCount });
            }
        }
        for (const row of incompletes.rows) {
            const aggregate = aggregateByInstitution.get(row.institution_id);
            const incompleteAttempts = nonnegativeCount(row.incomplete_attempts);
            if (aggregate && incompleteAttempts !== null) aggregate.incompleteAttempts = incompleteAttempts;
        }

        // An access audit is intentionally separate from diagnostic events and
        // carries no URL, correlation, provider string, or subject identifier.
        // The institution is retained from the timeline read above: re-reading
        // it here would let retention cleanup delete the correlation in
        // between and silently record no audit for a served response.
        const auditedInstitutionId = z.string().uuid().safeParse(timelineResult.rows[0]?.institution_id);
        if (!auditedInstitutionId.success) throw new NotFoundError('Verification diagnostic not found');
        const audit = await tx.query(
            `INSERT INTO verification_audit_events (actor_user_id, university_id, event_type, metadata)
             VALUES ($1, $2, 'verification_diagnostics_viewed', '{"surface":"redacted_admin"}'::jsonb)`,
            [actorId.data, auditedInstitutionId.data],
        );
        if (audit.rowCount !== 1) throw new Error('Diagnostic access audit was not recorded');
        await tx.query('COMMIT');
        success(res, {
            data: {
                timeline,
                aggregateWindow: 'last_30_days',
                measuredAt: measuredAt.toISOString(),
                windowStartedAt: new Date(measuredAt.getTime() - (30 * 24 * 60 * 60 * 1000)).toISOString(),
                aggregates: [...aggregateByInstitution.values()],
            },
        });
    } catch (error) {
        await tx.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        tx.release();
    }
}
