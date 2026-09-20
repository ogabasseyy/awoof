-- Attempt rows are never deleted, so the 047 retention index accumulates every
-- completed and failed attempt even after cleanup has nulled all of its
-- sensitive fields. With ORDER BY expires_at and a fixed batch limit, each
-- cleanup then scans an ever-growing prefix of already-scrubbed historical
-- rows to find terminal rows that still carry material. This replacement
-- only indexes terminal rows that still require scrubbing: the retention
-- query already restricts itself to these predicates, so it keeps using the
-- index while scrubbed rows fall out of it.
-- Plain (non-concurrent) creation matches every other migration here because
-- the migration runner applies each file inside its own transaction.
DROP INDEX IF EXISTS microsoft_verification_attempts_retention_idx;
CREATE INDEX microsoft_verification_attempts_retention_idx
    ON microsoft_verification_attempts (expires_at, id)
    WHERE status IN ('completed', 'failed')
      AND (state_hash IS NOT NULL
        OR browser_secret_hash IS NOT NULL
        OR encrypted_verifier IS NOT NULL
        OR nonce IS NOT NULL
        OR finish_secret_hash IS NOT NULL
        OR result IS NOT NULL);
