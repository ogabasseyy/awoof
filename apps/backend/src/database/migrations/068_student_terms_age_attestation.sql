-- Record the self-declared 18+ condition captured alongside student Terms.
-- Existing acceptance rows remain false: account age was never inferred.
-- accepted_at remains the server-generated timestamp for both declarations.
ALTER TABLE terms_acceptances
    ADD COLUMN age_attested BOOLEAN NOT NULL DEFAULT FALSE;
