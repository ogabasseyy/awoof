-- Task A3: retire legacy verification tokens and authorize merchant transaction
-- reporting against current enrollment evidence.
--
-- Additive only: no existing column is altered to NOT NULL and the existing
-- transaction receipt writer is untouched. The A4 claim-session table and its
-- nullable bindings ship in this same migration before release so product
-- assertions and authorizations bind before deployment (never a later retrofit).

ALTER TABLE verification_tokens ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

CREATE TABLE IF NOT EXISTS merchant_claim_sessions (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id uuid NOT NULL REFERENCES vendors(id),
    product_id uuid NOT NULL REFERENCES products(id),
    checkout_id text NOT NULL,
    browser_nonce_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (vendor_id, checkout_id),
    CHECK (expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX IF NOT EXISTS idx_merchant_claim_sessions_expires_at
    ON merchant_claim_sessions (expires_at);

ALTER TABLE merchant_assertions ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id);
ALTER TABLE merchant_assertions ADD COLUMN IF NOT EXISTS claim_session_id uuid REFERENCES merchant_claim_sessions(id);

CREATE TABLE IF NOT EXISTS merchant_benefit_authorizations (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    assertion_id uuid NOT NULL UNIQUE REFERENCES merchant_assertions(id),
    vendor_id uuid NOT NULL REFERENCES vendors(id),
    user_id uuid NOT NULL REFERENCES users(id),
    product_id uuid NOT NULL REFERENCES products(id),
    evidence_id uuid NOT NULL REFERENCES eligibility_evidence(id),
    processing_grant_id uuid NOT NULL REFERENCES verification_consents(id),
    disclosure_grant_id uuid NOT NULL REFERENCES verification_consents(id),
    list_price_snapshot NUMERIC(10, 2) NOT NULL CHECK (list_price_snapshot >= 0),
    student_price_snapshot NUMERIC(10, 2) NOT NULL CHECK (student_price_snapshot >= 0),
    currency text NOT NULL,
    pricing_version text NOT NULL,
    expires_at timestamptz NOT NULL,
    transaction_id uuid UNIQUE REFERENCES transactions(id),
    claim_session_id uuid REFERENCES merchant_claim_sessions(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_merchant_benefit_authorizations_cleanup
    ON merchant_benefit_authorizations (expires_at) WHERE transaction_id IS NULL;
