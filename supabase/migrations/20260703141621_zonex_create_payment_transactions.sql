/*
# Create payment_transactions table

1. New table for tracking all payment transactions:
   - Stores order IDs, payment IDs, amounts, status
   - Prevents duplicate payments
   - Records complete payment history

2. Security:
   - RLS enabled
   - Users can see their own transactions
   - Admins can see all transactions
*/

-- Create payment_transactions table if not exists
CREATE TABLE IF NOT EXISTS payment_transactions (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'wallet_topup',
  amount NUMERIC NOT NULL,
  currency TEXT DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'pending',
  gateway TEXT DEFAULT 'cashfree',
  payment_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;

-- User policies
DROP POLICY IF EXISTS select_own_payment_transactions ON payment_transactions;
CREATE POLICY select_own_payment_transactions ON payment_transactions FOR SELECT
  TO authenticated USING (user_id = auth.uid());

-- Admin policies
DROP POLICY IF EXISTS admin_all_payment_transactions ON payment_transactions;
CREATE POLICY admin_all_payment_transactions ON payment_transactions FOR ALL
  TO authenticated USING (
    EXISTS (SELECT 1 FROM admin_roles WHERE user_id = auth.uid() AND role IN ('admin', 'super_admin'))
  );

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_payment_transactions_user_id ON payment_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_status ON payment_transactions(status);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_payment_id ON payment_transactions(payment_id);