-- Account recovery scrubs every retained legacy reauth grant with the shared
-- 'scrubbed' sentinel, mirroring the 069 action-grant terminal transition.
-- 070 dropped the action-grant digest uniqueness for the same reason; the
-- legacy table kept its global UNIQUE, so two retained rows for one user (or
-- a second recovery after the first tombstone) abort the whole recovery
-- transaction. Drop the obsolete constraint: nothing looks a legacy grant up
-- by digest — the table is only scrubbed at recovery and pruned at expiry.
ALTER TABLE student_auth_reauth_grants
    DROP CONSTRAINT student_auth_reauth_grants_secret_hash_key;
