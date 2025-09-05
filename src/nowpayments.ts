// src/nowpayments.ts
import crypto from "crypto";
import { ENV } from "./env.js";

const BASE = "https://api.nowpayments.io/v1";

type CreateInvoiceArgs = {
  orderId: string;
  amount: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
};

type NowPaymentsInvoice = { id: number; invoice_url: string };

function getApiKey(): string {
  const key = (ENV.NOWPAYMENTS_API_KEY ?? "").trim(); // <- trim just in case
  if (!key) throw new Error("NOWPayments API key missing (ENV.NOWPAYMENTS_API_KEY)");
  return key;
}

export async function createInvoice(args: CreateInvoiceArgs): Promise<NowPaymentsInvoice> {
  if (!(args.amount > 0)) throw new Error(`Invalid amount "${args.amount}"`);
  if (!args.currency) throw new Error("Missing currency");

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15_000);

  try {
    const payload = {
      price_amount: Number(args.amount),
      price_currency: args.currency,
      order_id: args.orderId,
      order_description: `Invoice for ${args.orderId}`,
      ipn_callback_url: `${ENV.APP_URL}/ipn/nowpayments`,
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
    };

    const res = await fetch(`${BASE}/invoice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": getApiKey(),
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      if (res.status === 403) {
        // One-time diagnostic to confirm what the service is actually holding
        console.error(
          "NOWPayments 403 INVALID_API_KEY — key length:",
          (ENV.NOWPAYMENTS_API_KEY ?? "").length,
          "trimmed length:",
          getApiKey().length
        );
      }
      throw new Error(`NOWPayments invoice failed: ${res.status} ${text}`);
    }

    return JSON.parse(text) as NowPaymentsInvoice;
  } finally {
    clearTimeout(timeout);
  }
}

export function verifyIpnSignature(body: unknown, sigHeader?: string | null): boolean {
  if (!sigHeader || !ENV.NOWPAYMENTS_IPN_SECRET) return false;
  const json = JSON.stringify(body, Object.keys(body as object).sort());
  const h = crypto.createHmac("sha512", ENV.NOWPAYMENTS_IPN_SECRET);
  h.update(json);
  const expected = h.digest("hex");
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(sigHeader.trim(), "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
