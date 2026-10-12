-- Additive academic-profile store. One current row per student; no history or
-- source-observation child tables because this release integrates no new
-- institution data source. All provenance columns are server-managed: the
-- browser can never set canonical bindings, origins, or rule references.
-- Canonical binding is nullable so unbound students keep a claimed-school
-- profile. Physical account deletion cascades; catalogue pruning only unbinds.
CREATE TABLE student_academic_profiles (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    canonical_institution_id UUID NULL REFERENCES universities(id) ON DELETE SET NULL,
    observed_identity_version INTEGER NOT NULL CHECK (observed_identity_version >= 1),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    claimed_institution_state TEXT NOT NULL DEFAULT 'unanswered'
        CHECK (claimed_institution_state IN ('unanswered', 'supplied', 'unknown', 'skipped')),
    claimed_institution_name VARCHAR(255) NULL,
    claimed_institution_country VARCHAR(2) NULL
        CHECK (claimed_institution_country IS NULL OR claimed_institution_country ~ '^[A-Z]{2}$'),
    programme_state TEXT NOT NULL DEFAULT 'unanswered'
        CHECK (programme_state IN ('unanswered', 'supplied', 'unknown', 'skipped')),
    programme_id VARCHAR(128) NULL,
    course_label VARCHAR(255) NULL,
    entry_year_state TEXT NOT NULL DEFAULT 'unanswered'
        CHECK (entry_year_state IN ('unanswered', 'supplied', 'unknown', 'skipped')),
    entry_year INTEGER NULL CHECK (entry_year IS NULL OR (entry_year >= 1900 AND entry_year <= 2100)),
    entry_route_state TEXT NOT NULL DEFAULT 'unanswered'
        CHECK (entry_route_state IN ('unanswered', 'supplied', 'unknown', 'skipped')),
    entry_route TEXT NULL
        CHECK (entry_route IS NULL OR entry_route IN ('utme', 'de_200', 'de_300', 'transfer_other')),
    expected_graduation_year_state TEXT NOT NULL DEFAULT 'unanswered'
        CHECK (expected_graduation_year_state IN ('unanswered', 'supplied', 'unknown', 'skipped')),
    expected_graduation_year INTEGER NULL
        CHECK (expected_graduation_year IS NULL OR (expected_graduation_year >= 1900 AND expected_graduation_year <= 2200)),
    graduation_year_origin TEXT NULL
        CHECK (graduation_year_origin IS NULL OR graduation_year_origin IN ('calculated', 'self_reported')),
    estimate_basis_programme_id VARCHAR(128) NULL,
    estimate_basis_entry_year INTEGER NULL,
    estimate_basis_entry_route TEXT NULL,
    estimate_basis_rule_id VARCHAR(128) NULL,
    estimate_basis_source_version VARCHAR(128) NULL,
    estimate_stale BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT student_academic_profiles_claimed_check CHECK (
        (claimed_institution_state = 'supplied' AND claimed_institution_name IS NOT NULL AND claimed_institution_country IS NOT NULL)
        OR (claimed_institution_state <> 'supplied' AND claimed_institution_name IS NULL AND claimed_institution_country IS NULL)
    ),
    CONSTRAINT student_academic_profiles_programme_check CHECK (
        (programme_state = 'supplied'
            AND ((programme_id IS NOT NULL AND course_label IS NULL) OR (programme_id IS NULL AND course_label IS NOT NULL)))
        OR (programme_state <> 'supplied' AND programme_id IS NULL AND course_label IS NULL)
    ),
    CONSTRAINT student_academic_profiles_entry_year_value_check CHECK (
        (entry_year_state = 'supplied' AND entry_year IS NOT NULL)
        OR (entry_year_state <> 'supplied' AND entry_year IS NULL)
    ),
    CONSTRAINT student_academic_profiles_entry_route_value_check CHECK (
        (entry_route_state = 'supplied' AND entry_route IS NOT NULL)
        OR (entry_route_state <> 'supplied' AND entry_route IS NULL)
    ),
    CONSTRAINT student_academic_profiles_graduation_value_check CHECK (
        (expected_graduation_year_state = 'supplied' AND expected_graduation_year IS NOT NULL AND graduation_year_origin IS NOT NULL)
        OR (expected_graduation_year_state <> 'supplied' AND expected_graduation_year IS NULL AND graduation_year_origin IS NULL
            AND estimate_basis_programme_id IS NULL AND estimate_basis_entry_year IS NULL AND estimate_basis_entry_route IS NULL
            AND estimate_basis_rule_id IS NULL AND estimate_basis_source_version IS NULL AND estimate_stale = false)
    ),
    CONSTRAINT student_academic_profiles_basis_check CHECK (
        (graduation_year_origin = 'calculated'
            AND estimate_basis_programme_id IS NOT NULL AND estimate_basis_entry_year IS NOT NULL
            AND estimate_basis_entry_route IS NOT NULL AND estimate_basis_rule_id IS NOT NULL
            AND estimate_basis_source_version IS NOT NULL)
        OR (graduation_year_origin IS DISTINCT FROM 'calculated'
            AND estimate_basis_programme_id IS NULL AND estimate_basis_entry_year IS NULL AND estimate_basis_entry_route IS NULL
            AND estimate_basis_rule_id IS NULL AND estimate_basis_source_version IS NULL)
    )
);

CREATE INDEX idx_student_academic_profiles_student ON student_academic_profiles(student_id);
