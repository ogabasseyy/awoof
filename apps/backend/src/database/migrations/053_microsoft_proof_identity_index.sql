-- Owner unlink resolves proofs by identity and then joins eligibility
-- evidence through those proofs while holding authority locks. The proof
-- table is never deleted, and existing proof indexes begin with
-- provider_consent_id or attempt_id, so unlink scans the global proof
-- history as it grows. An (identity_id, id) index serves the unlink
-- filter, its ORDER BY, and the evidence join path.
CREATE INDEX microsoft_provider_proofs_identity_idx
    ON microsoft_provider_proofs (identity_id, id);
