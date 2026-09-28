-- Recovery clears every session, but legacy sid-less access tokens carry no
-- session to clear: they are rejected only while a recovery marker keeps the
-- account session-bound. Re-enrollment clears that marker (it also drives
-- the re-enrollment UX), which re-accepts an attacker's still-unexpired
-- sid-less token. Persist the binding requirement separately: once any
-- recovery completes, the account accepts only session-bound tokens
-- forever. The re-enrollment UX marker keeps its clear-on-activation
-- lifecycle; this column is never cleared.
ALTER TABLE users ADD COLUMN recovery_session_binding_required BOOLEAN NOT NULL DEFAULT false;
