import type { Request, Response } from "express";
import { getOrderById, getOrderByName } from "./shopify.js";
import { getMapping, saveMapping } from "./storage.js";
import { createInvoice } from "./nowpayments.js";
import { ENV } from "./env.js";

export async function renderPayPage(_req: Request, res: Response) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pay with Crypto</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
form{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}
input,button{padding:10px 12px;font-size:16px}
iframe{width:100%;height:80vh;border:0}
.note{color:#555;margin:6px 0 18px}
</style></head>
<body>
  <h2>Pay with Crypto</h2>
  <p class="note">Enter your order number (e.g. <strong>#1001</strong>) or paste the order ID.</p>
  <form method="POST" action="/pay/start" accept-charset="UTF-8">
    <input required name="order" placeholder="Order # (e.g. #1001) or Order ID" />
    <input name="email" placeholder="Email (optional)" />
    <button type="submit">Open Invoice</button>
  </form>
</body></html>`);
}

export async function startPay(req: Request, res: Response) {
  try {
    const { order, email } = (req.body || {}) as { order?: string; email?: string };
    if (!order) return res.status(400).send("Missing order");

    // Accept "#1001" / "1001" (lookup by name) or a GraphQL GID
    let shopifyOrder: any = null;
    const trimmed = order.trim();
    if (/^#?\d+$/.test(trimmed)) {
      const name = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
      shopifyOrder = await getOrderByName(name);
    } else {
      shopifyOrder = await getOrderById(trimmed);
    }
    if (!shopifyOrder) return res.status(404).send("Order not found");

    if (email && shopifyOrder.email && email.toLowerCase() !== shopifyOrder.email.toLowerCase()) {
      return res.status(403).send("Email does not match this order");
    }

    const orderId = shopifyOrder.id; // Admin GraphQL ID
    const existing = getMapping(orderId);
    let invoiceUrl = existing?.invoiceUrl;

    if (!invoiceUrl) {
      const outstanding = Number(shopifyOrder.totalOutstandingSet.shopMoney.amount || "0");
      if (outstanding <= 0) return res.status(200).send("This order has no outstanding balance.");
      const currency = shopifyOrder.totalOutstandingSet.shopMoney.currencyCode;

      const successUrl = `${ENV.APP_URL}/payment-success?order=${encodeURIComponent(orderId)}`;
      const cancelUrl  = `${ENV.APP_URL}/payment-cancel?order=${encodeURIComponent(orderId)}`;

      const invoice = await createInvoice({ orderId, amount: outstanding, currency, successUrl, cancelUrl });
      invoiceUrl = invoice.invoice_url;
      saveMapping(orderId, shopifyOrder.name, invoiceUrl);
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${shopifyOrder.name} — Crypto Invoice</title>
<style>html,body{height:100%}body{margin:0}</style></head>
<body>
  <iframe src="${invoiceUrl}" allow="payment *; clipboard-read; clipboard-write" style="width:100%;height:100%;border:0"></iframe>
</body></html>`);
  } catch (e) {
    console.error("startPay error:", e);
    res.status(500).send("Server error opening invoice");
  }
}
