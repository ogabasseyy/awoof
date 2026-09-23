-- Task review-loop: record student Terms of Service acceptance at registration.
--
-- The published Terms apply when accepted as part of registration, so a new
-- account must capture acceptance with the accepted version and time instead
-- of relying on a footer-style link next to the form.
CREATE TABLE terms_acceptances (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('student_terms')),
    terms_version TEXT NOT NULL CHECK (length(btrim(terms_version)) > 0),
    accepted BOOLEAN NOT NULL DEFAULT true CHECK (accepted),
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX terms_acceptances_student_current_idx
    ON terms_acceptances (user_id, id) WHERE kind = 'student_terms';
