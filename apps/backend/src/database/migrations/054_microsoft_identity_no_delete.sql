-- The 052 update guard still permits a direct DELETE. For a revoked
-- identity-only connection no provider-proof foreign key blocks deletion,
-- and removing the row also removes the globally unique
-- (tenant_id, object_id) tombstone, so a later linkMicrosoftIdentity would
-- treat the same provider identity as new and restore or transfer it
-- despite the support_required contract. Identities are therefore
-- append-only: revocation is the only terminal state change.
-- Plain (non-concurrent) DDL matches every other migration here because the
-- migration runner applies each file inside its own transaction. No
-- application, migration, or test writer deletes identity rows.
CREATE OR REPLACE FUNCTION microsoft_identity_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Microsoft identities are tombstones and cannot be deleted';
END $$;
CREATE TRIGGER microsoft_identity_before_delete
    BEFORE DELETE ON microsoft_identities FOR EACH ROW EXECUTE FUNCTION microsoft_identity_no_delete();
