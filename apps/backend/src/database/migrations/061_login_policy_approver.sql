-- Task review-loop: an enabled institution SSO policy must record the
-- authorized approver. Drafts stay nullable while disabled; enabling a
-- policy without approved_by is rejected.
--
-- Additive only: a CHECK constraint over existing columns. Existing rows
-- already satisfy it (policies are created disabled or with an approver).
ALTER TABLE institution_login_policies
    ADD CONSTRAINT institution_login_policies_enabled_requires_approver
    CHECK (NOT enabled OR approved_by IS NOT NULL);
