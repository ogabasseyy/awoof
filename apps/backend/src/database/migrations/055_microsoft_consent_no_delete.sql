-- The 052 consent guard handles only UPDATE, but a consent with no
-- dependent attempt or proof (for example, the user accepts and closes the
-- page before /start) has no foreign key blocking a direct DELETE. Removing
-- it would erase retained owner history while leaving its immutable
-- acceptance audit behind, so consent rows are append-only like identity
-- tombstones. No application, migration, or test writer deletes them.
CREATE OR REPLACE FUNCTION microsoft_consent_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Microsoft verification consents are retained and cannot be deleted';
END $$;
CREATE TRIGGER microsoft_consent_before_delete
    BEFORE DELETE ON microsoft_verification_consents FOR EACH ROW EXECUTE FUNCTION microsoft_consent_no_delete();
