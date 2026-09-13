-- Owner history is paged by the immutable connection timestamp and opaque ID.
-- The old partial index only protects the one-live-link invariant; it cannot
-- bound historical owner reads once revoked tombstones accumulate.
CREATE INDEX microsoft_identities_owner_history_idx
    ON microsoft_identities (user_id, linked_at DESC, id DESC);
