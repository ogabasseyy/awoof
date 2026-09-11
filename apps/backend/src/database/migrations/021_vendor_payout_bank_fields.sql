-- Persist vendor payout bank details for Paystack subaccount creation
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS bank_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS bank_code VARCHAR(20),
  ADD COLUMN IF NOT EXISTS account_number VARCHAR(20),
  ADD COLUMN IF NOT EXISTS account_name VARCHAR(255);
