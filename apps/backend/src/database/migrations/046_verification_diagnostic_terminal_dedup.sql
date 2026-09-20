-- One durable terminal diagnostic per verification attempt. This additive
-- constraint preserves existing rows (which must already satisfy it) and
-- makes future retries/conflicting after-transaction emissions harmless.
CREATE UNIQUE INDEX verification_diagnostic_events_one_terminal_idx
    ON verification_diagnostic_events (correlation_id)
    WHERE stage = 'finished';
