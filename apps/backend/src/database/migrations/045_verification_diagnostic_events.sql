-- Diagnostic correlations are generated only for newly created attempts.  Do
-- not fabricate events or correlation IDs for historical verification rows.
ALTER TABLE microsoft_verification_attempts
    ADD COLUMN diagnostic_correlation_id UUID;
ALTER TABLE microsoft_verification_attempts
    ADD CONSTRAINT microsoft_attempts_diagnostic_correlation_unique UNIQUE (diagnostic_correlation_id);

-- This deliberately contains no user, provider identity, email, token, code,
-- nonce, state, URL, response body, or arbitrary JSON payload.
CREATE TABLE verification_diagnostic_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    correlation_id UUID NOT NULL REFERENCES microsoft_verification_attempts(diagnostic_correlation_id),
    stage TEXT NOT NULL CHECK (stage IN ('started', 'callback_received', 'token_validated', 'education_response', 'policy_decision', 'finished')),
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'unknown')),
    reason TEXT NOT NULL CHECK (reason IN ('none', 'permission_required', 'invalid_identity', 'missing_data', 'upstream_unavailable', 'policy_denied', 'expired', 'cancelled')),
    http_status SMALLINT CHECK (http_status BETWEEN 100 AND 599),
    duration_ms DOUBLE PRECISION NOT NULL CHECK (duration_ms >= 0 AND duration_ms < 'Infinity'::double precision),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    institution_id UUID NOT NULL REFERENCES universities(id),
    policy_version INTEGER NOT NULL CHECK (policy_version >= 1)
);

-- Timeline reads are correlation ordered; retention cleanup will use the
-- timestamp index in Task 5 without adding a scheduler in this migration.
CREATE INDEX verification_diagnostic_events_timeline_idx
    ON verification_diagnostic_events (correlation_id, recorded_at, id);
CREATE INDEX verification_diagnostic_events_cleanup_idx
    ON verification_diagnostic_events (recorded_at);
