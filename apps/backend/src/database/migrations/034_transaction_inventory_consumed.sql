-- Legacy vendor-site reports never decremented inventory. Do not infer a debit
-- from their completed status. Only new atomic debit paths set this marker.
ALTER TABLE transactions ADD COLUMN inventory_consumed boolean NOT NULL DEFAULT false;
-- Historical marketplace fulfillment did debit stock; retain that provenance.
UPDATE transactions SET inventory_consumed = true
WHERE payment_source = 'awoof' AND paystack_reference IS NOT NULL AND status = 'completed';
