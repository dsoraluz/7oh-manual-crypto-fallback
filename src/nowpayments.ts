import crypto from "crypto";
import { ENV } from "./env.js";

const API = "https://api.nowpayments.io/v1";

type CreateInvoiceArgs = {
  orderId: string;               // Shopify Admin GID or name
  amount: number;                // outstanding amount
  currency: string;              // e.g. 'USD'
  successUrl: string;            // where to go after successful payment
  cancelUrl: string;             // where to go if cancelled
};

export async function createInvoice(args: CreateInvoiceArgs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000); // 15s timeout

  try {
    const res = await fetch(`${API}/invoice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ENV.NOWPAYMENTS_API_KEY
      },
      body: JSON.stringify({
        price_amount: args.amount,
        price_currency: args.currency,
        order_id: args.orderId,
        order_description: `Order ${args.orderId}`,
        ipn_callback_url: `${ENV.APP_URL}/ipn/nowpayments`,
        success_url: args.successUrl,
        cancel_url: args.cancelUrl
      }),
      signal: ctrl.signal
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`NOWPayments invoice failed: ${res.status} ${txt}`);
    }
    return res.json() as Promise<{ id: number; invoice_url: string }>;
  } finally {
    clearTimeout(t);
  }
}


// NOWPayments HMAC-SHA512 signature check.
// They sign the JSON body (keys sorted) with your IPN secret, header: x-nowpayments-sig
export function verifyIpnSignature(body: any, sigHeader?: string | null) {
  if (!sigHeader) return false;
  const json = JSON.stringify(body, Object.keys(body).sort());
  const h = crypto.createHmac("sha512", ENV.NOWPAYMENTS_IPN_SECRET);
  h.update(json);
  const digest = h.digest("hex");
  return digest === sigHeader;
}
