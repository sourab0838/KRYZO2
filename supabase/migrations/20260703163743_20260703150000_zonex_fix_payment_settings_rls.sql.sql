-- Fix RLS policies on payment_settings table
-- Add INSERT and UPDATE policies for service role and admins

-- Drop existing SELECT policy
DROP POLICY IF EXISTS select_payment_settings ON payment_settings;

-- Create new policies
-- Allow public read (for frontend config check)
CREATE POLICY "select_payment_settings" ON payment_settings
  FOR SELECT TO anon, authenticated
  USING (true);

-- Allow service role to manage all (for edge functions)
CREATE POLICY "service_role_all_payment_settings" ON payment_settings
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- Allow admins to insert
CREATE POLICY "admin_insert_payment_settings" ON payment_settings
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admin_roles 
      WHERE user_id = auth.uid() 
      AND role IN ('admin', 'super_admin')
    )
  );

-- Allow admins to update
CREATE POLICY "admin_update_payment_settings" ON payment_settings
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admin_roles 
      WHERE user_id = auth.uid() 
      AND role IN ('admin', 'super_admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admin_roles 
      WHERE user_id = auth.uid() 
      AND role IN ('admin', 'super_admin')
    )
  );

-- Ensure we have a row to update (avoid INSERT requirement)
INSERT INTO payment_settings (id, gateway_type, api_key, api_secret, webhook_secret, environment, is_live, is_configured, currency, company_name)
SELECT gen_random_uuid(), 'cashfree', '', '', '', 'test', false, false, 'INR', 'Zonex'
WHERE NOT EXISTS (SELECT 1 FROM payment_settings);

-- For testing: set test credentials directly
-- This ensures the flow works before admin UI testing
UPDATE payment_settings 
SET 
  api_key = 'CFTEST12345678',
  api_secret = 'test_secret_placeholder',
  environment = 'test',
  is_live = false,
  is_configured = true,
  updated_at = now()
WHERE id = (SELECT id FROM payment_settings LIMIT 1);