import { useState, useEffect } from 'react';
import { navigate } from '../lib/router';
import { useAuth } from '../lib/auth';
import { paymentApi } from '../lib/payments';
import { useToast } from '../components/Toast';
import { ArrowLeft, Plus, ShieldCheck, Loader2, ExternalLink } from 'lucide-react';

const QUICK_AMOUNTS = [100, 500, 1000, 2000, 5000];

export function AddMoneyPage() {
  const { user, loading } = useAuth();
  const toast = useToast();
  const [amount, setAmount] = useState<number>(0);
  const [amountInput, setAmountInput] = useState('');
  const [processing, setProcessing] = useState(false);
  const [config, setConfig] = useState<{ is_configured: boolean; gateway_type: string; environment: string } | null>(null);
  const [pendingOrder, setPendingOrder] = useState<string | null>(null);
  const [checkingPayment, setCheckingPayment] = useState(false);

  useEffect(() => {
    if (!loading && !user) { navigate('/login'); return; }
    paymentApi.getConfig().then(setConfig).catch(() => {});
  }, [loading, user]);

  if (loading || !user) return <div className="min-h-[60vh] grid place-items-center text-gray-500">Loading...</div>;

  const handleAmountChange = (val: string) => {
    setAmountInput(val);
    setAmount(val ? Math.max(0, Number(val)) : 0);
  };

  const handleProceed = async () => {
    if (amount < 1) { toast('error', 'Please enter a valid amount (minimum ₹1).'); return; }
    if (amount > 500000) { toast('error', 'Maximum amount is ₹5,00,000.'); return; }
    if (config && !config.is_configured) {
      toast('error', 'Payments are not configured yet. Please contact admin.');
      return;
    }
    if (!user) {
      toast('error', 'Please log in to add money to your wallet.');
      navigate('/login');
      return;
    }
    setProcessing(true);
    try {
      await paymentApi.openCheckout(
        amount,
        { email: user.email, username: user.username },
        async (orderId, paymentId) => {
          setProcessing(false);
          setPendingOrder(orderId);
          setCheckingPayment(true);

          // Verify the payment
          try {
            const result = await paymentApi.verifyPayment({
              order_id: orderId,
              amount,
              cf_payment_id: paymentId,
            });

            if (result.success) {
              toast('success', `₹${amount} added to your wallet!`);
              navigate('/wallet');
            } else {
              toast('error', result.message || 'Payment verification failed.');
            }
          } catch (err: any) {
            toast('error', err.message || 'Payment verification failed.');
          } finally {
            setCheckingPayment(false);
            setPendingOrder(null);
          }
        },
        () => {
          setProcessing(false);
          toast('info', 'Payment window closed. You can try again.');
        },
      );
    } catch (err: any) {
      toast('error', err.message || 'Failed to initiate payment.');
      setProcessing(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto px-4 sm:px-6 lg:px-8 py-10 animate-fade-in">
      <button onClick={() => navigate('/wallet')} className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gold-300 mb-6">
        <ArrowLeft size={16} /> Back to Wallet
      </button>

      <div className="mb-8">
        <span className="section-eyebrow">Wallet</span>
        <h1 className="font-display text-3xl font-bold text-white">Add Money</h1>
        <p className="mt-2 text-gray-400">Top up your wallet using secure payment.</p>
      </div>

      {/* Payment mode badge */}
      {config && (
        <div className="flex items-center gap-2 mb-6">
          <span className={`badge ${config.environment === 'live' ? 'bg-success-500/15 text-success-400' : 'bg-warning-500/15 text-warning-400'}`}>
            {config.environment === 'live' ? 'Live Mode' : 'Test Mode'}
          </span>
          <span className="text-xs text-gray-500">
            {config.gateway_type?.charAt(0).toUpperCase() + config.gateway_type?.slice(1) || 'Payment Gateway'}
          </span>
        </div>
      )}

      {/* Amount input */}
      <div className="glass rounded-2xl p-6 mb-6">
        <label className="label-field">Enter Amount (₹)</label>
        <div className="relative mt-2">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-2xl font-bold text-gold-400">₹</span>
          <input
            type="number"
            value={amountInput}
            onChange={(e) => handleAmountChange(e.target.value)}
            placeholder="0"
            min="1"
            max="500000"
            className="input-field text-2xl font-bold pl-10 py-4"
          />
        </div>
        <p className="text-xs text-gray-500 mt-2">Minimum ₹1, Maximum ₹5,00,000</p>

        <div className="mt-4 flex flex-wrap gap-2">
          {QUICK_AMOUNTS.map((a) => (
            <button
              key={a}
              onClick={() => { setAmount(a); setAmountInput(String(a)); }}
              className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${amount === a ? 'bg-gold-gradient text-ink-950' : 'glass text-gray-300 hover:text-gold-300'}`}
            >
              +₹{a}
            </button>
          ))}
        </div>
      </div>

      {/* Security notice */}
      <div className="flex items-start gap-2.5 p-3 rounded-lg bg-gold-400/5 border border-gold-400/15 mb-6">
        <ShieldCheck size={15} className="text-gold-400 mt-0.5 shrink-0" />
        <p className="text-xs text-gray-400">
          Payments are processed securely via Cashfree. Your payment details are encrypted and never stored on our servers.
        </p>
      </div>

      {/* Proceed button */}
      <button
        onClick={handleProceed}
        disabled={processing || checkingPayment || amount < 1}
        className="btn-gold w-full text-base"
      >
        {processing || checkingPayment ? (
          <>
            <Loader2 size={18} className="animate-spin" />
            {checkingPayment ? ' Verifying Payment...' : ' Processing...'}
          </>
        ) : (
          <>
            <Plus size={18} /> Proceed to Pay ₹{amount.toLocaleString('en-IN')}
            <ExternalLink size={14} className="ml-1" />
          </>
        )}
      </button>

      {pendingOrder && (
        <div className="mt-4 text-center">
          <p className="text-xs text-gray-500 mb-2">
            Payment window opened. Complete payment in the new tab.
          </p>
          <p className="text-xs text-gray-500">
            Order ID: <span className="font-mono text-gold-300">{pendingOrder}</span>
          </p>
        </div>
      )}

      {config && !config.is_configured && (
        <p className="mt-4 text-center text-xs text-warning-400">
          Payments are not configured. Please ask the admin to set up payment gateway credentials.
        </p>
      )}
    </div>
  );
}
