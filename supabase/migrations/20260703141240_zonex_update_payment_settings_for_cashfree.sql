/*
# Update Payment Settings for Cashfree

1. Changes:
   - Add gateway_type column ('cashfree' or 'razorpay')
   - Add api_key, api_secret, webhook_secret columns
   - Migrate existing Razorpay data
   - Update functions for new schema

2. Security:
   - Only admins can read/write secrets
   - Frontend only sees is_configured and environment
*/

-- Drop existing functions first
DROP FUNCTION IF EXISTS get_payment_config();

-- Add new columns for Cashfree support
ALTER TABLE payment_settings 
ADD COLUMN IF NOT EXISTS gateway_type TEXT DEFAULT 'cashfree';

ALTER TABLE payment_settings 
ADD COLUMN IF NOT EXISTS api_key TEXT DEFAULT '';

ALTER TABLE payment_settings 
ADD COLUMN IF NOT EXISTS api_secret TEXT DEFAULT '';

ALTER TABLE payment_settings 
ADD COLUMN IF NOT EXISTS webhook_secret TEXT DEFAULT '';

ALTER TABLE payment_settings 
ADD COLUMN IF NOT EXISTS environment TEXT DEFAULT 'test';

ALTER TABLE payment_settings 
ADD COLUMN IF NOT EXISTS is_live BOOLEAN DEFAULT false;

-- Migrate existing Razorpay data to new columns (if any)
UPDATE payment_settings 
SET 
  api_key = COALESCE(razorpay_key_id, ''),
  api_secret = COALESCE(razorpay_key_secret, ''),
  webhook_secret = COALESCE(razorpay_webhook_secret, ''),
  environment = CASE WHEN payment_mode = 'live' THEN 'live' ELSE 'test' END,
  is_live = (payment_mode = 'live'),
  gateway_type = 'razorpay'
WHERE api_key = '' AND razorpay_key_id IS NOT NULL AND razorpay_key_id != '';

-- Drop old columns
ALTER TABLE payment_settings DROP COLUMN IF EXISTS razorpay_key_id;
ALTER TABLE payment_settings DROP COLUMN IF EXISTS razorpay_key_secret;
ALTER TABLE payment_settings DROP COLUMN IF EXISTS razorpay_webhook_secret;
ALTER TABLE payment_settings DROP COLUMN IF EXISTS payment_mode;

-- Recreate get_payment_config function
CREATE OR REPLACE FUNCTION get_payment_config()
RETURNS TABLE (
  is_configured boolean,
  gateway_type text,
  environment text,
  currency text,
  company_name text
)
LANGUAGE sql
SECURITY DEFINER
AS $$
SELECT 
  is_configured,
  gateway_type,
  environment,
  currency,
  company_name
FROM payment_settings
LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_payment_config TO authenticated;
GRANT EXECUTE ON FUNCTION get_payment_config TO anon;

-- Admin function to get full payment settings (with secrets)
CREATE OR REPLACE FUNCTION admin_get_payment_settings()
RETURNS TABLE (
  id uuid,
  gateway_type text,
  api_key text,
  api_secret text,
  webhook_secret text,
  environment text,
  is_live boolean,
  is_configured boolean,
  currency text,
  company_name text
)
LANGUAGE sql
SECURITY DEFINER
AS $$
SELECT 
  ps.id,
  ps.gateway_type,
  ps.api_key,
  ps.api_secret,
  ps.webhook_secret,
  ps.environment,
  ps.is_live,
  ps.is_configured,
  ps.currency,
  ps.company_name
FROM payment_settings ps
WHERE EXISTS (
  SELECT 1 FROM admin_roles WHERE user_id = auth.uid() AND role IN ('admin', 'super_admin')
);
$$;

GRANT EXECUTE ON FUNCTION admin_get_payment_settings TO authenticated;

-- Admin function to save payment settings
CREATE OR REPLACE FUNCTION admin_save_payment_settings(
  p_gateway_type text,
  p_api_key text,
  p_api_secret text,
  p_webhook_secret text DEFAULT '',
  p_environment text DEFAULT 'test',
  p_currency text DEFAULT 'INR',
  p_company_name text DEFAULT 'Zonex'
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_is_admin boolean;
  v_existing_id uuid;
BEGIN
  -- Check admin role
  SELECT EXISTS (
    SELECT 1 FROM admin_roles WHERE user_id = auth.uid() AND role IN ('admin', 'super_admin')
  ) INTO v_is_admin;
  
  IF NOT v_is_admin THEN
    RETURN json_build_object('success', false, 'message', 'Unauthorized: admin role required');
  END IF;
  
  -- Validate required fields
  IF p_api_key IS NULL OR p_api_key = '' THEN
    RETURN json_build_object('success', false, 'message', 'API Key is required');
  END IF;
  
  IF p_api_secret IS NULL OR p_api_secret = '' THEN
    RETURN json_build_object('success', false, 'message', 'API Secret is required');
  END IF;
  
  -- Check existing settings
  SELECT id INTO v_existing_id FROM payment_settings LIMIT 1;
  
  IF v_existing_id IS NOT NULL THEN
    UPDATE payment_settings SET
      gateway_type = p_gateway_type,
      api_key = p_api_key,
      api_secret = p_api_secret,
      webhook_secret = p_webhook_secret,
      environment = p_environment,
      is_live = (p_environment = 'live'),
      is_configured = true,
      currency = p_currency,
      company_name = p_company_name,
      updated_at = now()
    WHERE id = v_existing_id;
  ELSE
    INSERT INTO payment_settings (
      gateway_type, api_key, api_secret, webhook_secret,
      environment, is_live, is_configured, currency, company_name
    ) VALUES (
      p_gateway_type, p_api_key, p_api_secret, p_webhook_secret,
      p_environment, (p_environment = 'live'), true, p_currency, p_company_name
    );
  END IF;
  
  RETURN json_build_object('success', true, 'message', 'Payment settings saved successfully');
END;
$$;

GRANT EXECUTE ON FUNCTION admin_save_payment_settings TO authenticated;