CREATE TABLE merchant_assertions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code_hash text NOT NULL UNIQUE,
    user_id uuid NOT NULL REFERENCES users(id),
    vendor_id uuid NOT NULL REFERENCES vendors(id),
    origin text NOT NULL,
    purpose text NOT NULL,
    campaign_id text NOT NULL,
    disclosure_grant_id uuid NOT NULL REFERENCES verification_consents(id),
    evidence_id uuid NOT NULL REFERENCES eligibility_evidence(id),
    processing_grant_id uuid NOT NULL REFERENCES verification_consents(id),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE merchant_subjects (
    vendor_id uuid NOT NULL REFERENCES vendors(id),
    user_id uuid NOT NULL REFERENCES users(id),
    subject uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    PRIMARY KEY (vendor_id, user_id)
);
CREATE TABLE merchant_assertion_receipts (
    vendor_id uuid NOT NULL REFERENCES vendors(id),
    idempotency_key text NOT NULL,
    assertion_id uuid NOT NULL UNIQUE REFERENCES merchant_assertions(id),
    receipt jsonb NOT NULL,
    PRIMARY KEY (vendor_id, idempotency_key)
);
