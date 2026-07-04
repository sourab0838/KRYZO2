import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Zonex-Token",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  });
}

function errorResponse(message: string, status = 400) {
  return json({ error: message }, status);
}

// Get current user from x-zonex-token header (supports both Supabase JWT and custom auth_sessions)
// Also falls back to Authorization header for Supabase JWTs
async function getCurrentUserId(req: Request): Promise<string | null> {
  // Check x-zonex-token header first (used by frontend)
  let token = req.headers.get("x-zonex-token");

  // Fallback to Authorization Bearer token
  if (!token) {
    const authHeader = req.headers.get("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    }
  }

  if (!token) return null;

  // Check if it looks like a Supabase JWT (three base64 parts separated by dots)
  if (token.includes(".") && token.split(".").length === 3) {
    try {
      // Verify Supabase JWT using anon key client
      const supabaseClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: { user }, error } = await supabaseClient.auth.getUser(token);
      if (user && !error) {
        console.log(`JWT verified for user: ${user.id}`);
        return user.id;
      }
      console.log(`JWT verification failed: ${error?.message || 'unknown error'}`);
    } catch (err) {
      console.log(`JWT verification exception: ${err}`);
      // Fall through to auth_sessions lookup
    }
  }

  // Fall back to custom auth_sessions lookup
  const { createHash } = await import("node:crypto");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data } = await supabase
    .from("auth_sessions")
    .select("user_id")
    .eq("token_hash", tokenHash)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  console.log(`auth_sessions lookup: ${data?.user_id || 'not found'}`);
  return data?.user_id ?? null;
}

// Get payment settings from DB (full settings for backend)
async function getPaymentSettings() {
  const { data } = await supabase
    .from("payment_settings")
    .select("*")
    .limit(1)
    .maybeSingle();
  return data;
}

// Get user profile
async function getUserProfile(userId: string) {
  const { data } = await supabase
    .from("profiles")
    .select("id, email, username, full_name, phone_number")
    .eq("id", userId)
    .maybeSingle();
  return data;
}

// Generate Cashfree payment session
async function createCashfreePaymentSession(
  orderId: string,
  amount: number,
  customerProfile: { id: string; email: string; phone?: string; name?: string },
  settings: { api_key: string; api_secret: string; environment: string; currency: string; company_name: string }
): Promise<{ success: boolean; payment_session_id?: string; payment_link?: string; order_id?: string; error?: string; debug?: any }> {
  const baseUrl = settings.environment === "live"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";

  // Debug: Log credentials and endpoint (mask sensitive data)
  console.log("=== Cashfree API Debug ===");
  console.log("Environment:", settings.environment);
  console.log("Base URL:", baseUrl);
  console.log("API Key (first 8 chars):", settings.api_key?.substring(0, 8) || "EMPTY");
  console.log("API Key length:", settings.api_key?.length || 0);
  console.log("API Secret length:", settings.api_secret?.length || 0);
  console.log("Currency:", settings.currency || "INR");

  // Validate credentials before making the call
  if (!settings.api_key || settings.api_key.trim() === "") {
    return {
      success: false,
      error: "Cashfree API Key is not configured. Please set it in Admin > Payment Settings.",
      debug: { reason: "missing_api_key" }
    };
  }
  if (!settings.api_secret || settings.api_secret.trim() === "") {
    return {
      success: false,
      error: "Cashfree API Secret is not configured. Please set it in Admin > Payment Settings.",
      debug: { reason: "missing_api_secret" }
    };
  }

  const requestBody = {
    order_id: orderId,
    order_amount: amount,
    order_currency: settings.currency || "INR",
    customer_details: {
      customer_id: customerProfile.id,
      customer_email: customerProfile.email,
      customer_phone: customerProfile.phone || "9999999999",
      customer_name: customerProfile.name || customerProfile.email.split("@")[0],
    },
    order_meta: {
      return_url: `${supabaseUrl}/functions/v1/zonex-payments/return?order_id=${orderId}`,
      payment_methods: "cc,dc,upi,nb,wallet",
    },
    order_note: `Zonex Payment - ${orderId}`,
  };

  console.log("Request Body:", JSON.stringify(requestBody, null, 2));

  try {
    const orderResponse = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-version": "2023-08-01",
        "x-client-id": settings.api_key,
        "x-client-secret": settings.api_secret,
      },
      body: JSON.stringify(requestBody),
    });

    const orderData = await orderResponse.json();

    // Log full response details
    console.log("Cashfree Response Status:", orderResponse.status, orderResponse.statusText);
    console.log("Cashfree Response Body:", JSON.stringify(orderData, null, 2));

    if (!orderResponse.ok) {
      // Extract detailed error message
      const errorMessage = orderData.message || orderData.error?.message || `Cashfree Error (${orderResponse.status})`;
      const errorDetails = {
        status: orderResponse.status,
        statusText: orderResponse.statusText,
        code: orderData.code || orderData.error?.code,
        message: errorMessage,
        type: orderData.type || orderData.error?.type,
      };
      console.error("Cashfree API Error:", JSON.stringify(errorDetails, null, 2));

      // Provide specific guidance for common errors
      let userMessage = errorMessage;
      if (orderResponse.status === 401 || orderData.code === "authentication_failed" || orderData.message?.toLowerCase().includes("unauthorized")) {
        userMessage = `Cashfree authentication failed. Please verify your API Key and Secret Key are correct for ${settings.environment.toUpperCase()} mode. Check https://merchant.cashfree.com/merchants/api-keys`;
      } else if (orderResponse.status === 400) {
        userMessage = `Invalid request: ${errorMessage}`;
      }

      return {
        success: false,
        error: userMessage,
        debug: errorDetails
      };
    }

    return {
      success: true,
      payment_session_id: orderData.payment_session_id,
      payment_link: `https://${settings.environment === "live" ? "www" : "sandbox"}.cashfree.com/pglinks/pay/${orderData.payment_session_id}`,
      order_id: orderId,
    };
  } catch (err: any) {
    console.error("Cashfree network error:", err);
    return {
      success: false,
      error: "Network error connecting to Cashfree. Please try again.",
      debug: { reason: "network_error", message: err.message }
    };
  }
}

// Generate unique order ID
function generateOrderId(prefix: string = "zonex"): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${random}`.toUpperCase();
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    // Strip the function path prefix - handle both full path and short path
    let path = url.pathname
      .replace(/^\/functions\/v1\/zonex-payments\/?/, "")
      .replace(/^\/zonex-payments\/?/, "") || "/";

    // Ensure path starts with /
    if (path && !path.startsWith("/")) {
      path = "/" + path;
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    // Route: GET /config - Public config for frontend
    if (path === "/config" && req.method === "GET") {
      const settings = await getPaymentSettings();

      // Return the actual database value for is_configured
      // This reflects whether the admin has saved payment settings
      return json({
        is_configured: settings?.is_configured || false,
        gateway_type: settings?.gateway_type || "cashfree",
        environment: settings?.environment || "test",
        currency: settings?.currency || "INR",
        company_name: settings?.company_name || "Zonex",
      });
    }

    // Route: POST /create-order - Create payment session for wallet top-up
    if (path === "/create-order" && req.method === "POST") {
      const userId = await getCurrentUserId(req);
      if (!userId) return errorResponse("Unauthorized", 401);

      const { amount } = body;
      if (typeof amount !== "number" || isNaN(amount) || amount < 1) {
        return errorResponse("Invalid amount. Minimum amount is ₹1");
      }
      if (amount > 500000) {
        return errorResponse("Maximum amount is ₹5,00,000");
      }

      const settings = await getPaymentSettings();

      // Validate Cashfree credentials are real (not placeholders)
      if (!settings?.api_key || !settings?.api_secret) {
        return errorResponse("Payment gateway not configured. Please add Cashfree API credentials in Admin > Payment Settings.");
      }

      // Detect placeholder/invalid credentials
      const isPlaceholder =
        settings.api_key.length < 20 ||
        settings.api_secret.length < 20 ||
        settings.api_key === "CF_TEST_KEY" ||
        settings.api_secret === "CF_TEST_SECRET" ||
        !settings.api_key.startsWith("CF_TEST_") && !settings.api_key.startsWith("CF_LIVE_");

      if (isPlaceholder) {
        return errorResponse(
          "Cashfree credentials are not configured. Please add your real Cashfree API Key and Secret in Admin > Payment Settings. " +
          "Get your credentials from: https://merchant.cashfree.com/merchants/api-keys"
        );
      }

      // Get user profile
      const userProfile = await getUserProfile(userId);
      if (!userProfile?.email) {
        return errorResponse("User profile incomplete. Please update your email.");
      }

      // Generate unique order ID
      const orderId = generateOrderId("wallet");

      // Create Cashfree order
      const result = await createCashfreePaymentSession(
        orderId,
        amount,
        {
          id: userId,
          email: userProfile.email,
          phone: userProfile.phone_number || undefined,
          name: userProfile.full_name || userProfile.username,
        },
        {
          api_key: settings.api_key,
          api_secret: settings.api_secret,
          environment: settings.environment || "test",
          currency: settings.currency || "INR",
          company_name: settings.company_name || "Zonex",
        }
      );

      if (!result.success) {
        return errorResponse(result.error || "Failed to create payment session", 500);
      }

      return json({
        success: true,
        order_id: orderId,
        amount: amount,
        currency: settings.currency || "INR",
        payment_session_id: result.payment_session_id,
        payment_link: result.payment_link,
        gateway: settings.gateway_type || "cashfree",
        environment: settings.environment || "test",
      });
    }

    // Route: POST /verify-payment - Verify and credit wallet
    if (path === "/verify-payment" && req.method === "POST") {
      const userId = await getCurrentUserId(req);
      if (!userId) return errorResponse("Unauthorized", 401);

      const { order_id, amount, cf_payment_id } = body;
      if (!order_id) return errorResponse("Order ID required");

      // Check for duplicate
      const { data: existingTx } = await supabase
        .from("wallet_transactions")
        .select("id, status")
        .eq("razorpay_order_id", order_id)
        .eq("status", "success")
        .maybeSingle();

      if (existingTx) {
        return json({ success: true, message: "Payment already processed", duplicate: true });
      }

      const settings = await getPaymentSettings();

      // Validate Cashfree credentials are real (not placeholders)
      if (!settings?.api_key || !settings?.api_secret) {
        return errorResponse("Payment gateway not configured. Please add Cashfree API credentials in Admin > Payment Settings.");
      }

      // Detect placeholder/invalid credentials
      const isPlaceholder =
        settings.api_key.length < 20 ||
        settings.api_secret.length < 20 ||
        settings.api_key === "CF_TEST_KEY" ||
        settings.api_secret === "CF_TEST_SECRET";

      if (isPlaceholder) {
        return errorResponse(
          "Cashfree credentials are not configured. Please add your real Cashfree API Key and Secret in Admin > Payment Settings. " +
          "Get your credentials from: https://merchant.cashfree.com/merchants/api-keys"
        );
      }

      // Verify with Cashfree
      const baseUrl = settings.environment === "live"
        ? "https://api.cashfree.com/pg"
        : "https://sandbox.cashfree.com/pg";

      const verifyResponse = await fetch(`${baseUrl}/orders/${order_id}/payments`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-api-version": "2023-08-01",
          "x-client-id": settings.api_key,
          "x-client-secret": settings.api_secret,
        },
      });

      const paymentData = await verifyResponse.json();

      if (!verifyResponse.ok || !Array.isArray(paymentData) || paymentData.length === 0) {
        return errorResponse("Payment verification failed", 400);
      }

      const payment = paymentData[0];
      if (payment.payment_status !== "SUCCESS") {
        return errorResponse(`Payment ${payment.payment_status.toLowerCase()}`, 400);
      }

      // Credit wallet
      const { error: creditError } = await supabase.rpc("process_wallet_credit", {
        p_user_id: userId,
        p_amount: amount,
        p_type: "deposit",
        p_description: "Wallet top-up",
        p_razorpay_payment_id: payment.cf_payment_id,
        p_razorpay_order_id: order_id,
      });

      if (creditError) {
        return errorResponse("Failed to credit wallet: " + creditError.message, 500);
      }

      await supabase.rpc("create_notification", {
        p_user_id: userId,
        p_type: "payment_success",
        p_title: "Payment Successful",
        p_message: `₹${amount} has been added to your wallet.`,
      });

      return json({ success: true, message: "Wallet credited successfully" });
    }

    // Route: POST /create-purchase - Create purchase order
    if (path === "/create-purchase" && req.method === "POST") {
      const userId = await getCurrentUserId(req);
      if (!userId) return errorResponse("Unauthorized", 401);

      const { listing_id } = body;
      if (!listing_id) return errorResponse("Listing ID required");

      const { data: listing } = await supabase
        .from("account_listings")
        .select("*")
        .eq("id", listing_id)
        .eq("status", "approved")
        .maybeSingle();

      if (!listing) return errorResponse("Listing not found or not available");
      if (listing.seller_id === userId) return errorResponse("You cannot buy your own listing");

      // Check for duplicate
      const { data: existingOrder } = await supabase
        .from("orders")
        .select("id, status")
        .eq("listing_id", listing_id)
        .eq("buyer_id", userId)
        .in("status", ["pending", "payment_successful", "awaiting_delivery", "buyer_reviewing"])
        .maybeSingle();

      if (existingOrder) return errorResponse("You already have a pending order");

      const settings = await getPaymentSettings();

      // Validate Cashfree credentials are real (not placeholders)
      if (!settings?.api_key || !settings?.api_secret) {
        return errorResponse("Payment gateway not configured. Please add Cashfree API credentials in Admin > Payment Settings.");
      }

      // Detect placeholder/invalid credentials
      const isPlaceholder =
        settings.api_key.length < 20 ||
        settings.api_secret.length < 20 ||
        settings.api_key === "CF_TEST_KEY" ||
        settings.api_secret === "CF_TEST_SECRET";

      if (isPlaceholder) {
        return errorResponse(
          "Cashfree credentials are not configured. Please add your real Cashfree API Key and Secret in Admin > Payment Settings. " +
          "Get your credentials from: https://merchant.cashfree.com/merchants/api-keys"
        );
      }

      // Calculate fees
      const listingPrice = listing.price;
      const platformFee = Math.round(listingPrice * 0.10);
      const sellerCommission = Math.round(listingPrice * 0.10);
      const sellerPayout = listingPrice - sellerCommission;
      const totalAmount = listingPrice + platformFee;

      // Create order
      const { data: order, error: orderError } = await supabase
        .from("orders")
        .insert({
          listing_id,
          buyer_id: userId,
          seller_id: listing.seller_id,
          amount: totalAmount,
          status: "pending",
          platform_fee: platformFee,
          seller_commission: sellerCommission,
          seller_payout: sellerPayout,
          escrow_status: "none",
          delivery_status: "pending",
          seller_whatsapp_revealed: listing.seller_whatsapp,
        })
        .select()
        .single();

      if (orderError) return errorResponse("Failed to create order: " + orderError.message, 500);

      const userProfile = await getUserProfile(userId);
      if (!userProfile?.email) return errorResponse("Please complete your profile with email");

      const orderId = generateOrderId("purchase");

      const result = await createCashfreePaymentSession(
        orderId,
        totalAmount,
        {
          id: userId,
          email: userProfile.email,
          phone: userProfile.phone_number || undefined,
          name: userProfile.full_name || userProfile.username,
        },
        {
          api_key: settings.api_key,
          api_secret: settings.api_secret,
          environment: settings.environment || "test",
          currency: settings.currency || "INR",
          company_name: settings.company_name || "Zonex",
        }
      );

      if (!result.success) {
        await supabase.from("orders").delete().eq("id", order.id);
        return errorResponse(result.error || "Failed to create payment session", 500);
      }

      await supabase.from("orders").update({ razorpay_order_id: orderId }).eq("id", order.id);

      return json({
        success: true,
        order_id: order.id,
        payment_order_id: orderId,
        amount: totalAmount,
        currency: settings.currency || "INR",
        payment_session_id: result.payment_session_id,
        payment_link: result.payment_link,
        gateway: settings.gateway_type || "cashfree",
        environment: settings.environment || "test",
        listing_title: listing.title,
        seller_whatsapp: listing.seller_whatsapp,
        total_amount: totalAmount,
        platform_fee: platformFee,
        seller_payout: sellerPayout,
      });
    }

    // Route: POST /verify-purchase
    if (path === "/verify-purchase" && req.method === "POST") {
      const userId = await getCurrentUserId(req);
      if (!userId) return errorResponse("Unauthorized", 401);

      const { order_id, payment_order_id, cf_payment_id } = body;
      if (!order_id) return errorResponse("Order ID required");

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", order_id)
        .eq("buyer_id", userId)
        .maybeSingle();

      if (!order) return errorResponse("Order not found");
      if (order.status !== "pending") return errorResponse("Order already processed");

      // Check duplicate
      const { data: existingTx } = await supabase
        .from("wallet_transactions")
        .select("id")
        .eq("razorpay_payment_id", cf_payment_id)
        .eq("status", "success")
        .maybeSingle();

      if (existingTx) return json({ success: true, message: "Already processed", duplicate: true });

      const settings = await getPaymentSettings();

      // Validate Cashfree credentials are real (not placeholders)
      if (!settings?.api_key || !settings?.api_secret) {
        return errorResponse("Payment gateway not configured. Please add Cashfree API credentials in Admin > Payment Settings.");
      }

      // Detect placeholder/invalid credentials
      const isPlaceholder =
        settings.api_key.length < 20 ||
        settings.api_secret.length < 20 ||
        settings.api_key === "CF_TEST_KEY" ||
        settings.api_secret === "CF_TEST_SECRET";

      if (isPlaceholder) {
        return errorResponse(
          "Cashfree credentials are not configured. Please add your real Cashfree API Key and Secret in Admin > Payment Settings. " +
          "Get your credentials from: https://merchant.cashfree.com/merchants/api-keys"
        );
      }

      // Verify with Cashfree
      const baseUrl = settings.environment === "live"
        ? "https://api.cashfree.com/pg"
        : "https://sandbox.cashfree.com/pg";

      const verifyResponse = await fetch(`${baseUrl}/orders/${payment_order_id}/payments`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-api-version": "2023-08-01",
          "x-client-id": settings.api_key,
          "x-client-secret": settings.api_secret,
        },
      });

      const paymentData = await verifyResponse.json();

      if (!verifyResponse.ok || !Array.isArray(paymentData) || paymentData.length === 0) {
        return errorResponse("Payment verification failed", 400);
      }

      const payment = paymentData[0];
      if (payment.payment_status !== "SUCCESS") {
        return errorResponse(`Payment ${payment.payment_status.toLowerCase()}`, 400);
      }

      // Update order
      await supabase.from("orders").update({
        status: "payment_successful",
        razorpay_payment_id: payment.cf_payment_id,
        escrow_status: "held",
        delivery_status: "pending",
        updated_at: new Date().toISOString(),
      }).eq("id", order_id);

      await supabase.rpc("hold_escrow", {
        p_order_id: order_id,
        p_buyer_id: order.buyer_id,
        p_seller_id: order.seller_id,
        p_total_amount: order.amount,
        p_platform_fee: order.platform_fee,
        p_seller_commission: order.seller_commission,
        p_seller_payout: order.seller_payout,
      });

      await supabase.from("account_listings").update({ status: "sold" }).eq("id", order.listing_id);

      await supabase.rpc("create_notification", {
        p_user_id: userId,
        p_type: "payment_success",
        p_title: "Payment Successful",
        p_message: `Payment of ₹${order.amount} successful.`,
      });

      await supabase.rpc("create_notification", {
        p_user_id: order.seller_id,
        p_type: "order_created",
        p_title: "Order Received",
        p_message: `New order received. ₹${order.seller_payout} pending in escrow.`,
      });

      return json({
        success: true,
        message: "Payment verified",
        seller_whatsapp: order.seller_whatsapp_revealed,
      });
    }

    // Route: POST /save-settings - Admin only
    if (path === "/save-settings" && req.method === "POST") {
      const userId = await getCurrentUserId(req);
      if (!userId) return errorResponse("Unauthorized", 401);

      const { data: adminRole } = await supabase
        .from("admin_roles")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle();

      if (!adminRole || !["admin", "super_admin"].includes(adminRole.role)) {
        return errorResponse("Access denied: admin role required", 403);
      }

      const { gateway_type, api_key, api_secret, webhook_secret, environment, currency, company_name } = body;

      // API Key is always required
      if (!api_key) {
        return errorResponse("API Key is required");
      }

      // Get existing settings
      const { data: existingSettings } = await supabase
        .from("payment_settings")
        .select("*")
        .limit(1)
        .maybeSingle();

      // For new settings, api_secret is required
      // For updates, keep existing api_secret if new one not provided
      const finalApiSecret = api_secret || (existingSettings?.api_secret || "");
      if (!finalApiSecret) {
        return errorResponse("API Secret is required for initial setup");
      }

      let updateError;
      if (existingSettings?.id) {
        // Update existing - only update fields that are provided
        const updateData: Record<string, any> = {
          gateway_type: gateway_type || existingSettings.gateway_type || "cashfree",
          api_key: api_key,
          environment: environment || existingSettings.environment || "test",
          is_live: (environment === "live"),
          is_configured: true,
          currency: currency || existingSettings.currency || "INR",
          company_name: company_name || existingSettings.company_name || "Zonex",
          updated_at: new Date().toISOString(),
        };

        // Update api_secret only if new one provided
        if (api_secret) {
          updateData.api_secret = api_secret;
        }

        // Update webhook_secret only if new one provided
        if (webhook_secret !== undefined) {
          updateData.webhook_secret = webhook_secret;
        }

        const { error } = await supabase
          .from("payment_settings")
          .update(updateData)
          .eq("id", existingSettings.id);
        updateError = error;
      } else {
        // Insert new
        const { error } = await supabase
          .from("payment_settings")
          .insert({
            gateway_type: gateway_type || "cashfree",
            api_key: api_key,
            api_secret: finalApiSecret,
            webhook_secret: webhook_secret || "",
            environment: environment || "test",
            is_live: (environment === "live"),
            is_configured: true,
            currency: currency || "INR",
            company_name: company_name || "Zonex",
          });
        updateError = error;
      }

      if (updateError) {
        return errorResponse("Failed to save settings: " + updateError.message, 500);
      }

      return json({ success: true, message: "Payment settings saved successfully" });
    }

    // Route: POST /test-connection - Test Cashfree credentials
    if (path === "/test-connection" && req.method === "POST") {
      const userId = await getCurrentUserId(req);
      if (!userId) return errorResponse("Unauthorized", 401);

      const { data: adminRole } = await supabase
        .from("admin_roles")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle();

      if (!adminRole || !["admin", "super_admin"].includes(adminRole.role)) {
        return errorResponse("Access denied: admin role required", 403);
      }

      const settings = await getPaymentSettings();
      if (!settings || !settings.api_key || !settings.api_secret) {
        return json({
          success: false,
          message: "API credentials not configured. Please save your API Key and Secret first.",
          details: { reason: "missing_credentials" }
        });
      }

      const baseUrl = settings.environment === "live"
        ? "https://api.cashfree.com/pg"
        : "https://sandbox.cashfree.com/pg";

      console.log("Testing Cashfree connection...");
      console.log("Environment:", settings.environment);
      console.log("Base URL:", baseUrl);
      console.log("API Key (first 8 chars):", settings.api_key?.substring(0, 8));

      // Make a test order creation request
      const testOrderId = `test_${Date.now()}`;
      const testAmount = 1;

      try {
        const testResponse = await fetch(`${baseUrl}/orders`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-version": "2023-08-01",
            "x-client-id": settings.api_key,
            "x-client-secret": settings.api_secret,
          },
          body: JSON.stringify({
            order_id: testOrderId,
            order_amount: testAmount,
            order_currency: settings.currency || "INR",
            customer_details: {
              customer_id: "test_customer",
              customer_email: "test@example.com",
              customer_phone: "9999999999",
              customer_name: "Test User",
            },
            order_note: "Connection test - will be cancelled",
          }),
        });

        const testData = await testResponse.json();

        console.log("Test Response Status:", testResponse.status);
        console.log("Test Response Body:", JSON.stringify(testData, null, 2));

        if (!testResponse.ok) {
          // Extract detailed error
          let errorMessage = testData.message || `HTTP ${testResponse.status}`;
          let errorCode = testData.code || testData.error?.code;
          let errorType = testData.type || testData.error?.type;

          // Provide specific guidance
          if (testResponse.status === 401 || testData.code === "authentication_failed" ||
              testData.message?.toLowerCase().includes("unauthorized") ||
              testData.message?.toLowerCase().includes("invalid") ||
              testData.message?.toLowerCase().includes("authentication")) {
            errorMessage = `Authentication failed. Your API Key or Secret is incorrect for ${settings.environment.toUpperCase()} mode. ` +
              `Please verify credentials at https://merchant.cashfree.com/merchants/api-keys`;
          } else if (testResponse.status === 403) {
            errorMessage = `Permission denied. Ensure your API key has the correct permissions for ${settings.environment.toUpperCase()} mode.`;
          } else if (testResponse.status === 400 && testData.message?.includes("customer_phone")) {
            // This is actually success - credentials work, just phone format issue
            return json({
              success: true,
              message: "Connection successful! Credentials are valid.",
              details: { status: testResponse.status, environment: settings.environment }
            });
          }

          return json({
            success: false,
            message: errorMessage,
            details: {
              status: testResponse.status,
              code: errorCode,
              type: errorType,
              environment: settings.environment,
              response: testData
            }
          });
        }

        // Success - credentials work!
        // Cancel the test order
        if (testData.order_id || testData.cf_order_id) {
          const cancelOrderId = testData.order_id || testData.cf_order_id;
          await fetch(`${baseUrl}/orders/${cancelOrderId}`, {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
              "x-api-version": "2023-08-01",
              "x-client-id": settings.api_key,
              "x-client-secret": settings.api_secret,
            },
          }).catch(() => {}); // Ignore cancel errors
        }

        return json({
          success: true,
          message: "Connection successful! Cashfree credentials are valid.",
          details: {
            status: testResponse.status,
            environment: settings.environment,
            gateway: settings.gateway_type
          }
        });
      } catch (err: any) {
        console.error("Connection test error:", err);
        return json({
          success: false,
          message: "Network error connecting to Cashfree. Check your internet connection.",
          details: { reason: "network_error", message: err.message }
        });
      }
    }

    // Route: POST /mark-delivered
    if (path === "/mark-delivered" && req.method === "POST") {
      const userId = await getCurrentUserId(req);
      if (!userId) return errorResponse("Unauthorized", 401);

      const { order_id } = body;
      if (!order_id) return errorResponse("Order ID required");

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", order_id)
        .eq("seller_id", userId)
        .maybeSingle();

      if (!order) return errorResponse("Order not found");
      if (order.escrow_status !== "held") return errorResponse("Escrow not held");
      if (order.delivery_status !== "pending") return errorResponse("Already delivered");

      await supabase.from("orders").update({
        delivery_status: "delivered",
        status: "buyer_reviewing",
        updated_at: new Date().toISOString(),
      }).eq("id", order_id);

      await supabase.rpc("create_notification", {
        p_user_id: order.buyer_id,
        p_type: "seller_delivered",
        p_title: "Account Delivered",
        p_message: "Seller has delivered the account. Please confirm receipt.",
      });

      return json({ success: true, message: "Marked as delivered" });
    }

    // Route: POST /confirm-delivery
    if (path === "/confirm-delivery" && req.method === "POST") {
      const userId = await getCurrentUserId(req);
      if (!userId) return errorResponse("Unauthorized", 401);

      const { order_id } = body;
      if (!order_id) return errorResponse("Order ID required");

      const { data: order } = await supabase
        .from("orders")
        .select("*")
        .eq("id", order_id)
        .eq("buyer_id", userId)
        .maybeSingle();

      if (!order) return errorResponse("Order not found");
      if (order.delivery_status !== "delivered") return errorResponse("Not yet delivered by seller");

      const { error: releaseError } = await supabase.rpc("release_escrow", { p_order_id: order_id });
      if (releaseError) return errorResponse("Failed to release escrow: " + releaseError.message, 500);

      await supabase.from("orders").update({
        delivery_status: "confirmed",
        status: "completed",
        updated_at: new Date().toISOString(),
      }).eq("id", order_id);

      await supabase.rpc("create_notification", {
        p_user_id: userId,
        p_type: "buyer_confirmed",
        p_title: "Order Completed",
        p_message: "You confirmed receipt. Funds released to seller.",
      });

      await supabase.rpc("create_notification", {
        p_user_id: order.seller_id,
        p_type: "funds_released",
        p_title: "Funds Released",
        p_message: `₹${order.seller_payout} released from escrow to your balance.`,
      });

      return json({ success: true, message: "Delivery confirmed, funds released" });
    }

    // Route: POST /webhook
    if (path === "/webhook" && req.method === "POST") {
      const rawBody = await req.text();
      const event = JSON.parse(rawBody);

      // Handle webhook (implement signature verification in production)
      console.log("Webhook received:", event.type);

      if (event.type === "PAYMENT_SUCCESS_WEBHOOK" || event.event === "payment.success") {
        const paymentData = event.data || event.payload?.payment?.entity;
        const orderId = paymentData?.order_id || paymentData?.cf_order_id;
        const paymentId = paymentData?.cf_payment_id || paymentData?.payment_id;

        const { data: order } = await supabase
          .from("orders")
          .select("*")
          .eq("razorpay_order_id", orderId)
          .maybeSingle();

        if (order && order.status === "pending") {
          await supabase.from("orders").update({
            status: "payment_successful",
            razorpay_payment_id: paymentId,
            escrow_status: "held",
            updated_at: new Date().toISOString(),
          }).eq("id", order.id);

          await supabase.rpc("hold_escrow", {
            p_order_id: order.id,
            p_buyer_id: order.buyer_id,
            p_seller_id: order.seller_id,
            p_total_amount: order.amount,
            p_platform_fee: order.platform_fee,
            p_seller_commission: order.seller_commission,
            p_seller_payout: order.seller_payout,
          });

          await supabase.from("account_listings").update({ status: "sold" }).eq("id", order.listing_id);
        }
      }

      return json({ received: true });
    }

    // Root endpoint - health check
    if (path === "/" || path === "") {
      return json({
        status: "ok",
        service: "zonex-payments",
        version: "2.0.0",
        endpoints: ["/config", "/create-order", "/verify-payment", "/create-purchase", "/verify-purchase", "/mark-delivered", "/confirm-delivery", "/save-settings", "/test-connection", "/webhook"]
      });
    }

    return errorResponse("Not found: " + path, 404);
  } catch (err: any) {
    console.error("Payment function error:", err);
    return errorResponse(err.message || "Internal server error", 500);
  }
});
