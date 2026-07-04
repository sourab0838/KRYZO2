import { getToken } from './authApi';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const paymentsUrl = `${supabaseUrl}/functions/v1/zonex-payments`;

async function payFetch(path: string, body: Record<string, unknown> = {}, method: 'POST' | 'GET' = 'POST') {
  const token = getToken();

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Payment service not configured. Missing Supabase credentials.');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${supabaseAnonKey}`,
  };
  if (token) headers['x-zonex-token'] = token;

  // Build URL
  const url = method === 'GET'
    ? `${paymentsUrl}${path}${path.includes('?') ? '&' : '?'}_t=${Date.now()}`
    : `${paymentsUrl}${path}`;

  // Use AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      mode: 'cors',
      credentials: 'omit',
      body: method === 'GET' ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
  } catch (networkError: any) {
    clearTimeout(timeoutId);
    if (networkError.name === 'AbortError') {
      throw new Error('Request timed out. Please try again.');
    }
    throw new Error(`Network error: ${networkError.message || 'Failed to connect to payment service'}`);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

export interface CreateOrderResult {
  success: boolean;
  order_id: string;
  amount: number;
  currency: string;
  payment_session_id?: string;
  payment_link?: string;
  gateway: string;
  environment: string;
  demo_mode?: boolean;
  message?: string;
}

export interface CreatePurchaseResult {
  success: boolean;
  order_id: string;
  payment_order_id: string;
  amount: number;
  currency: string;
  payment_session_id?: string;
  payment_link?: string;
  gateway: string;
  environment: string;
  demo_mode?: boolean;
  listing_title: string;
  seller_whatsapp: string;
  total_amount: number;
  platform_fee: number;
  seller_payout: number;
}

export interface VerifyResult {
  success: boolean;
  message: string;
  seller_whatsapp?: string;
  duplicate?: boolean;
}

export interface PaymentConfig {
  is_configured: boolean;
  gateway_type: string;
  environment: string;
  currency: string;
  company_name: string;
}

export const paymentApi = {
  getConfig: async (): Promise<PaymentConfig> => {
    const data = await payFetch('/config', {}, 'GET');
    // Handle array response from RPC function
    if (Array.isArray(data) && data.length > 0) {
      return data[0] as PaymentConfig;
    }
    return data as PaymentConfig;
  },

  createOrder: async (amount: number): Promise<CreateOrderResult> => {
    return payFetch('/create-order', { amount });
  },

  verifyPayment: async (params: {
    order_id: string;
    amount: number;
    cf_payment_id?: string;
  }): Promise<VerifyResult> => {
    return payFetch('/verify-payment', params);
  },

  createPurchase: async (listing_id: string): Promise<CreatePurchaseResult> => {
    return payFetch('/create-purchase', { listing_id });
  },

  verifyPurchase: async (params: {
    order_id: string;
    payment_order_id: string;
    cf_payment_id?: string;
  }): Promise<VerifyResult> => {
    return payFetch('/verify-purchase', params);
  },

  markDelivered: async (order_id: string): Promise<VerifyResult> => {
    return payFetch('/mark-delivered', { order_id });
  },

  confirmDelivery: async (order_id: string): Promise<VerifyResult> => {
    return payFetch('/confirm-delivery', { order_id });
  },

  saveSettings: async (params: {
    gateway_type: string;
    api_key: string;
    api_secret: string;
    webhook_secret?: string;
    environment: 'test' | 'live';
    currency?: string;
    company_name?: string;
  }): Promise<{ success: boolean; message: string }> => {
    return payFetch('/save-settings', params);
  },

  testConnection: async (): Promise<{
    success: boolean;
    message: string;
    details?: {
      status?: number;
      code?: string;
      type?: string;
      environment?: string;
      response?: any;
    };
  }> => {
    return payFetch('/test-connection', {});
  },

  // Open Cashfree checkout - redirects to Cashfree hosted page
  openCheckout: async (
    amount: number,
    user: { email: string; username: string },
    onSuccess: (orderId: string, paymentId?: string) => void,
    onDismiss?: () => void
  ): Promise<void> => {
    try {
      const order = await paymentApi.createOrder(amount);

      // If we have a payment_link, open it in a new tab/window
      if (order.payment_link) {
        // Open Cashfree hosted checkout in new tab
        const checkoutWindow = window.open(order.payment_link, '_blank');

        // Poll for payment completion
        const pollInterval = setInterval(async () => {
          try {
            const result = await paymentApi.verifyPayment({
              order_id: order.order_id,
              amount: order.amount,
            });

            if (result.success) {
              clearInterval(pollInterval);
              onSuccess(order.order_id);
            } else if (result.duplicate) {
              clearInterval(pollInterval);
              onSuccess(order.order_id);
            }
          } catch {
            // Continue polling
          }
        }, 3000);

        // Cleanup after 15 minutes
        setTimeout(() => {
          clearInterval(pollInterval);
          onDismiss?.();
        }, 15 * 60 * 1000);

        return;
      }

      // Fallback: if payment_link not available, check for session ID
      if (order.payment_session_id) {
        // Load Cashfree SDK and open checkout
        const cf = (window as any).Cashfree;
        if (cf) {
          cf.checkout({
            paymentSessionId: order.payment_session_id,
            redirectTarget: '_blank',
          });
          return;
        }

        // If SDK not loaded, redirect to the session URL
        const checkoutUrl = `${order.environment === 'live' ? 'https://www.cashfree.com' : 'https://sandbox.cashfree.com'}/pg/orders/${order.payment_session_id}`;
        window.open(checkoutUrl, '_blank');

        // Poll for completion
        const pollInterval = setInterval(async () => {
          try {
            const result = await paymentApi.verifyPayment({
              order_id: order.order_id,
              amount: order.amount,
            });

            if (result.success || result.duplicate) {
              clearInterval(pollInterval);
              onSuccess(order.order_id);
            }
          } catch {
            // Continue polling
          }
        }, 3000);

        setTimeout(() => {
          clearInterval(pollInterval);
          onDismiss?.();
        }, 15 * 60 * 1000);
      }
    } catch (err: any) {
      throw new Error(err.message || 'Failed to initiate payment');
    }
  },

  // Open checkout for account purchase
  openPurchaseCheckout: async (
    listingId: string,
    user: { email: string; username: string },
    onSuccess: (orderId: string, purchaseData: CreatePurchaseResult) => void,
    onDismiss?: () => void
  ): Promise<void> => {
    try {
      const purchase = await paymentApi.createPurchase(listingId);

      // Open Cashfree checkout
      if (purchase.payment_link) {
        const checkoutWindow = window.open(purchase.payment_link, '_blank');

        // Poll for completion
        const pollInterval = setInterval(async () => {
          try {
            const result = await paymentApi.verifyPurchase({
              order_id: purchase.order_id,
              payment_order_id: purchase.payment_order_id,
            });

            if (result.success || result.duplicate) {
              clearInterval(pollInterval);
              onSuccess(purchase.order_id, purchase);
            }
          } catch {
            // Continue polling
          }
        }, 3000);

        setTimeout(() => {
          clearInterval(pollInterval);
          onDismiss?.();
        }, 15 * 60 * 1000);

        return;
      }

      // Fallback: redirect to Cashfree
      if (purchase.payment_session_id) {
        const checkoutUrl = `${purchase.environment === 'live' ? 'https://www.cashfree.com' : 'https://sandbox.cashfree.com'}/pg/orders/${purchase.payment_session_id}`;
        window.open(checkoutUrl, '_blank');

        const pollInterval = setInterval(async () => {
          try {
            const result = await paymentApi.verifyPurchase({
              order_id: purchase.order_id,
              payment_order_id: purchase.payment_order_id,
            });

            if (result.success || result.duplicate) {
              clearInterval(pollInterval);
              onSuccess(purchase.order_id, purchase);
            }
          } catch {
            // Continue polling
          }
        }, 3000);

        setTimeout(() => {
          clearInterval(pollInterval);
          onDismiss?.();
        }, 15 * 60 * 1000);
      }
    } catch (err: any) {
      throw new Error(err.message || 'Failed to initiate purchase');
    }
  },

  // Load Cashfree SDK (optional, for embedded checkout)
  loadCashfreeSDK: (): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (document.getElementById('cashfree-sdk')) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.id = 'cashfree-sdk';
      script.src = 'https://www.cashfree.com/cashfree-js/v3';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Cashfree SDK'));
      document.body.appendChild(script);
    });
  },
};
