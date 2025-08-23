import type { Request, Response } from "express";
import { getOrderById } from "./shopify.js";
import { getMapping, saveMapping } from "./storage.js";
import { createInvoice } from "./nowpayments.js";
import { ENV } from "./env.js";

/**
 * Resolve an invoice URL for the Thank-You page.
 * Body: { orderId: string, shop?: string }
 *  - orderId: Shopify Admin GID (e.g., gid://shopify/Order/123...)
 *  - shop: optional myshopify.com domain; if omitted we use ENV.SHOP
 */
export async function orderStatusInvoiceUrl(req: Request, res: Response) {
  try {
    const { orderId, shop: shopDomain } = (req.body || {}) as { orderId?: string; shop?: string };
    if (!orderId) return res.status(400).json({ error: "missing orderId" });

    // 1) Look up current outstanding from Shopify
    const order = await getOrderById(orderId, shopDomain);
    const outstanding = Number(order?.totalOutstandingSet?.shopMoney?.amount || "0");
    const currency = order?.totalOutstandingSet?.shopMoney?.currencyCode;
    if (!order || !currency) return res.status(404).json({ error: "order_not_found" });
    if (outstanding <= 0) return res.json({ invoiceUrl: null }); // nothing to collect

    // 2) If we have a cached invoice and the expected amount hasn't changed, reuse it
    const cached = getMapping(orderId);
    if (cached?.invoiceUrl && cached.expectedAmount !== undefined && cached.currency === currency) {
      const sameAmount = Math.abs((cached.expectedAmount ?? 0) - outstanding) < 1e-8;
      if (sameAmount) {
        return res.json({
          invoiceUrl: cached.invoiceUrl,
          amount: cached.expectedAmount,
          currency: cached.currency
        });
      }
      // else: amount changed → fall through and regenerate
    }

    // 3) Create a new invoice now
    const successUrl = `${ENV.APP_URL}/payment-success?order=${encodeURIComponent(orderId)}`;
    const cancelUrl  = `${ENV.APP_URL}/payment-cancel?order=${encodeURIComponent(orderId)}`;

    const invoice = await createInvoice({
      orderId,
      amount: outstanding,
      currency,
      successUrl,
      cancelUrl
    });

    // 4) Save mapping (with expected amount/currency) for reuse + IPN guard
    saveMapping(orderId, order.name, invoice.invoice_url, outstanding, currency);

    return res.json({
      invoiceUrl: invoice.invoice_url,
      amount: outstanding,
      currency
    });
  } catch (e) {
    console.error("orderStatusInvoiceUrl error:", e);
    return res.status(500).json({ error: "server_error" });
  }
}
