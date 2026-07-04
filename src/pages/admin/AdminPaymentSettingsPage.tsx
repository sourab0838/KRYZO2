import { useEffect, useState } from 'react';
import { navigate } from '../../lib/router';
import { AdminLayout } from '../../components/AdminLayout';
import { checkAdminRole } from '../../lib/admin';
import { paymentApi } from '../../lib/payments';
import { useToast } from '../../components/Toast';
import { CreditCard, Save, Loader2, AlertTriangle, CheckCircle2, KeyRound, Globe, Building2, Lock, ShieldCheck, Webhook, Settings, Zap, XCircle, Info } from 'lucide-react';

export function AdminPaymentSettingsPage() {
  const toast = useToast();
  const [checking, setChecking] = useState(true);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; details?: any } | null>(null);
  const [config, setConfig] = useState({
    gateway_type: 'cashfree' as 'cashfree' | 'razorpay',
    api_key: '',
    api_secret: '',
    webhook_secret: '',
    environment: 'test' as 'test' | 'live',
    currency: 'INR',
    company_name: 'Zonex',
  });
  const [hasExistingSecret, setHasExistingSecret] = useState(false);
  const [hasExistingWebhook, setHasExistingWebhook] = useState(false);

  useEffect(() => {
    (async () => {
      const role = await checkAdminRole();
      if (!role) { navigate('/dashboard'); return; }
      setChecking(false);

      try {
        // Get public config
        const publicConfig = await paymentApi.getConfig();
        setConfig((prev) => ({
          ...prev,
          gateway_type: (publicConfig as any).gateway_type || 'cashfree',
          environment: (publicConfig as any).environment || 'test',
          currency: (publicConfig as any).currency || 'INR',
          company_name: (publicConfig as any).company_name || 'Zonex',
        }));

        // Admin can see if secrets are configured
        if (publicConfig && (publicConfig as any).is_configured) {
          setHasExistingSecret(true);
          setHasExistingWebhook(true);
        }
      } catch (e: any) {
        toast('error', e?.message ?? 'Failed to load payment config');
      } finally {
        setLoadingConfig(false);
      }
    })();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!config.api_key) {
      toast('error', 'API Key is required.');
      return;
    }
    // Only require secret if not already configured or user is changing it
    if (!hasExistingSecret && !config.api_secret) {
      toast('error', 'API Secret is required for initial setup.');
      return;
    }

    setSaving(true);
    setTestResult(null);
    try {
      const result = await paymentApi.saveSettings({
        gateway_type: config.gateway_type,
        api_key: config.api_key,
        api_secret: config.api_secret || undefined,
        webhook_secret: config.webhook_secret || undefined,
        environment: config.environment,
        currency: config.currency,
        company_name: config.company_name,
      });

      if (result.success) {
        toast('success', 'Payment settings saved successfully!');
        if (config.api_secret) setHasExistingSecret(true);
        if (config.webhook_secret) setHasExistingWebhook(true);
        // Refresh config from database to ensure UI is in sync
        try {
          const freshConfig = await paymentApi.getConfig();
          setConfig((prev) => ({
            ...prev,
            gateway_type: freshConfig.gateway_type || prev.gateway_type,
            environment: freshConfig.environment || prev.environment,
            currency: freshConfig.currency || prev.currency,
            company_name: freshConfig.company_name || prev.company_name,
          }));
        } catch { /* ignore refresh error */ }
      } else {
        toast('error', result.message || 'Failed to save settings.');
      }
    } catch (err: any) {
      toast('error', err.message || 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await paymentApi.testConnection();
      setTestResult(result);
      if (result.success) {
        toast('success', 'Connection successful! Credentials are valid.');
      } else {
        toast('error', result.message || 'Connection test failed.');
      }
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || 'Connection test failed.' });
      toast('error', err.message || 'Connection test failed.');
    } finally {
      setTesting(false);
    }
  };

  if (checking) return <div className="min-h-screen grid place-items-center text-gray-500">Checking access…</div>;

  const isConfigured = hasExistingSecret;

  return (
    <AdminLayout currentPath="/admin/payments">
      <div className="animate-fade-in max-w-2xl">
        <span className="section-eyebrow">Admin Panel</span>
        <h1 className="font-display text-2xl md:text-3xl font-bold text-white mb-6 flex items-center gap-2">
          <CreditCard className="text-gold-400" /> Payment Gateway Settings
        </h1>

        {loadingConfig ? (
          <div className="glass rounded-2xl p-5 mb-6 text-center text-gray-500">Loading configuration…</div>
        ) : isConfigured ? (
          <div className="glass rounded-2xl p-5 mb-6 flex items-center gap-4 border border-success-500/20">
            <span className="grid place-items-center w-10 h-10 rounded-lg bg-success-500/10 text-success-400"><CheckCircle2 size={20} /></span>
            <div className="flex-1">
              <p className="text-sm font-semibold text-white">Payment Gateway Configured</p>
              <p className="text-xs text-gray-400">
                <span className="text-gold-300 font-semibold uppercase">{config.gateway_type}</span> is active in{' '}
                <span className="text-gold-300 font-semibold uppercase">{config.environment}</span> mode.
              </p>
            </div>
            <span className={`badge ${config.environment === 'live' ? 'bg-success-500/15 text-success-400' : 'bg-warning-500/15 text-warning-400'}`}>
              {config.environment === 'live' ? 'Live' : 'Test'}
            </span>
          </div>
        ) : (
          <div className="glass rounded-2xl p-5 mb-6 flex items-center gap-4 border border-warning-500/20">
            <span className="grid place-items-center w-10 h-10 rounded-lg bg-warning-500/10 text-warning-400"><AlertTriangle size={20} /></span>
            <div>
              <p className="text-sm font-semibold text-white">Not Configured</p>
              <p className="text-xs text-gray-400">Add payment gateway credentials to enable payments on your website.</p>
            </div>
          </div>
        )}

        {/* Test Connection Result */}
        {testResult && (
          <div className={`glass rounded-2xl p-5 mb-6 flex items-start gap-4 border ${testResult.success ? 'border-success-500/20' : 'border-error-500/20'}`}>
            <span className={`grid place-items-center w-10 h-10 rounded-lg shrink-0 ${testResult.success ? 'bg-success-500/10 text-success-400' : 'bg-error-500/10 text-error-400'}`}>
              {testResult.success ? <CheckCircle2 size={20} /> : <XCircle size={20} />}
            </span>
            <div className="flex-1">
              <p className={`text-sm font-semibold ${testResult.success ? 'text-success-400' : 'text-error-400'}`}>
                {testResult.success ? 'Connection Successful' : 'Connection Failed'}
              </p>
              <p className="text-xs text-gray-400 mt-1">{testResult.message}</p>
              {testResult.details && !testResult.success && (
                <div className="mt-3 p-3 bg-ink-950 rounded-lg">
                  <p className="text-xs text-gray-500 mb-1">Details:</p>
                  <code className="text-xs text-gray-300 break-all">
                    {JSON.stringify(testResult.details, null, 2)}
                  </code>
                </div>
              )}
            </div>
          </div>
        )}

        <form onSubmit={handleSave} className="glass rounded-2xl p-6 space-y-5">
          {/* Gateway Type */}
          <div>
            <label className="label-field inline-flex items-center gap-1.5"><Settings size={14} className="text-gold-400" /> Payment Gateway</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setConfig((c) => ({ ...c, gateway_type: 'cashfree' }))}
                className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${config.gateway_type === 'cashfree' ? 'bg-gold-gradient text-ink-950' : 'glass text-gray-300'}`}
              >
                Cashfree
              </button>
              <button
                type="button"
                onClick={() => setConfig((c) => ({ ...c, gateway_type: 'razorpay' }))}
                className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${config.gateway_type === 'razorpay' ? 'bg-gold-gradient text-ink-950' : 'glass text-gray-300'}`}
              >
                Razorpay
              </button>
            </div>
          </div>

          {/* API Key */}
          <div>
            <label className="label-field inline-flex items-center gap-1.5"><KeyRound size={14} className="text-gold-400" /> API Key (Client ID) *</label>
            <input
              value={config.api_key}
              onChange={(e) => setConfig((c) => ({ ...c, api_key: e.target.value }))}
              placeholder={config.gateway_type === 'cashfree' ? 'CFXXXXXXXXXXXXXXX' : 'rzp_test_XXXXXXXXXX'}
              className="input-field font-mono text-sm"
            />
            <p className="mt-1 text-xs text-gray-500">
              {config.gateway_type === 'cashfree'
                ? 'Found in Cashfree Dashboard → Developers → API Credentials → ' + (config.environment === 'live' ? 'Production' : 'Test') + ' Credentials'
                : 'Found in Razorpay Dashboard → Settings → API Keys'}
            </p>
          </div>

          {/* API Secret */}
          <div>
            <label className="label-field inline-flex items-center gap-1.5"><Lock size={14} className="text-gold-400" /> API Secret Key {hasExistingSecret ? '' : '*'}</label>
            <input
              type="password"
              value={config.api_secret}
              onChange={(e) => setConfig((c) => ({ ...c, api_secret: e.target.value }))}
              placeholder={hasExistingSecret ? '•••••••• (configured — type to update)' : '••••••••••••••••'}
              className="input-field font-mono text-sm"
            />
            <p className="mt-1 text-xs text-gray-500">
              {hasExistingSecret ? 'Secret is securely stored. Leave blank to keep current value.' : 'Stored securely in database. Never exposed to frontend.'}
            </p>
          </div>

          {/* Webhook Secret */}
          <div>
            <label className="label-field inline-flex items-center gap-1.5"><Webhook size={14} className="text-gold-400" /> Webhook Secret</label>
            <input
              type="password"
              value={config.webhook_secret}
              onChange={(e) => setConfig((c) => ({ ...c, webhook_secret: e.target.value }))}
              placeholder={hasExistingWebhook ? '•••••••• (configured — type to update)' : 'Optional — for webhook verification'}
              className="input-field font-mono text-sm"
            />
            <p className="mt-1 text-xs text-gray-500">Used to verify incoming webhook events from the payment gateway.</p>
          </div>

          {/* Environment */}
          <div>
            <label className="label-field">Environment Mode</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setConfig((c) => ({ ...c, environment: 'test' }))}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all ${config.environment === 'test' ? 'bg-gold-gradient text-ink-950' : 'glass text-gray-300'}`}
              >
                <ShieldCheck size={15} /> Test Mode
              </button>
              <button
                type="button"
                onClick={() => setConfig((c) => ({ ...c, environment: 'live' }))}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all ${config.environment === 'live' ? 'bg-gold-gradient text-ink-950' : 'glass text-gray-300'}`}
              >
                <Globe size={15} /> Live Mode
              </button>
            </div>
            <div className="mt-2 p-3 bg-info-500/5 border border-info-500/15 rounded-lg">
              <div className="flex items-start gap-2">
                <Info size={14} className="text-info-400 mt-0.5 shrink-0" />
                <p className="text-xs text-gray-400">
                  <span className="text-info-400 font-medium">Important:</span> Use the correct credentials for each mode — Test credentials for Test mode, Production credentials for Live mode.
                  Test mode does not process real payments.
                </p>
              </div>
            </div>
          </div>

          {/* Currency */}
          <div>
            <label className="label-field">Currency</label>
            <select value={config.currency} onChange={(e) => setConfig((c) => ({ ...c, currency: e.target.value }))} className="input-field text-sm">
              <option value="INR">INR - Indian Rupee (₹)</option>
              <option value="USD">USD - US Dollar ($)</option>
            </select>
          </div>

          {/* Company Name */}
          <div>
            <label className="label-field inline-flex items-center gap-1.5"><Building2 size={14} className="text-gold-400" /> Merchant / Company Name</label>
            <input
              value={config.company_name}
              onChange={(e) => setConfig((c) => ({ ...c, company_name: e.target.value }))}
              placeholder="Your Company Name"
              className="input-field"
            />
            <p className="mt-1 text-xs text-gray-500">Displayed on the payment checkout page.</p>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3">
            <button type="submit" disabled={saving} className="btn-gold flex-1 text-base">
              {saving ? <><Loader2 size={18} className="animate-spin" /> Saving…</> : <><Save size={18} /> Save Configuration</>}
            </button>
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={testing || !isConfigured}
              className="btn-outline px-6 text-base"
            >
              {testing ? <><Loader2 size={18} className="animate-spin" /></> : <><Zap size={18} /> Test</>}
            </button>
          </div>

          {!isConfigured && (
            <p className="text-center text-xs text-gray-500">Save your API Key and Secret first, then test the connection.</p>
          )}
        </form>

        {/* Webhook URL Info */}
        <div className="glass rounded-2xl p-6 mt-6">
          <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
            <Webhook size={16} className="text-gold-400" /> Webhook Configuration
          </h3>
          <p className="text-xs text-gray-400 mb-3">Configure this URL in your {config.gateway_type === 'cashfree' ? 'Cashfree' : 'Razorpay'} dashboard to receive payment events:</p>
          <div className="bg-ink-950 rounded-lg p-3">
            <code className="text-xs text-gold-300 break-all">
              {import.meta.env.VITE_SUPABASE_URL}/functions/v1/zonex-payments/webhook
            </code>
          </div>
          <p className="text-xs text-gray-500 mt-3">
            Events handled: payment.success, payment.failed, order.paid
          </p>
        </div>

        {/* Cashfree Setup Instructions */}
        {config.gateway_type === 'cashfree' && (
          <div className="glass rounded-2xl p-6 mt-6">
            <h3 className="text-sm font-semibold text-white mb-3">How to get Cashfree API Credentials</h3>
            <ol className="text-xs text-gray-400 space-y-2 list-decimal list-inside">
              <li>Log in to <a href="https://merchant.cashfree.com/" target="_blank" rel="noopener" className="text-gold-300 hover:underline">Cashfree Merchant Dashboard</a></li>
              <li>Go to <strong>Developers → API Credentials</strong></li>
              <li>For Test Mode: Copy the <strong>Test API Key</strong> and <strong>Test Secret Key</strong></li>
              <li>For Live Mode: Switch to <strong>Production</strong> tab and copy the <strong>Live API Key</strong> and <strong>Live Secret Key</strong></li>
              <li>Paste them above and click <strong>Save Configuration</strong></li>
              <li>Click <strong>Test</strong> to verify the connection works</li>
            </ol>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
