import type { Request, Response } from "express";
import { createInvoice } from "./nowpayments.js";
import { saveMapping } from "./storage.js";
import { getOrderById } from "./shopify.js";
import { ENV } from "./env.js";

type OrdersCreateBody = { admin_graphql_api_id?: string };

export async function ordersCreate(req: Request, res: Response) {
  try {
    // Real shop that sent the webhook
    const shopHeader = (req.header("x-shopify-shop-domain") || "").toLowerCase();

    // Optional safety: ignore unexpected shops
    if (shopHeader && shopHeader !== (ENV.SHOP || "").toLowerCase()) {
      console.warn(`Webhook from unexpected shop ${shopHeader}; expected ${ENV.SHOP}`);
      return res.sendStatus(200);
    }

    const body = req.body as OrdersCreateBody;
    const orderGid = body.admin_graphql_api_id;
    if (!orderGid) return res.sendStatus(200);

    // Use the header shop when calling Admin API
    const o = await getOrderById(orderGid, shopHeader);
    const amount = Number(o?.totalOutstandingSet?.shopMoney?.amount || "0");
    if (!o || amount <= 0) return res.sendStatus(200);

    const currency  = o.totalOutstandingSet.shopMoney.currencyCode;
    const successUrl = `${ENV.APP_URL}/payment-success?order=${encodeURIComponent(orderGid)}`;
    const cancelUrl  = `${ENV.APP_URL}/payment-cancel?order=${encodeURIComponent(orderGid)}`;

    const invoice = await createInvoice({
      orderId: orderGid,
      amount,
      currency,
      successUrl,
      cancelUrl
    });

    // cache mapping (with expected amount/currency)
    saveMapping(orderGid, o.name, invoice.invoice_url, amount, currency);

    console.log("orders/create OK:", orderGid, "→ invoice", invoice.invoice_url);
    return res.sendStatus(200);
  } catch (e) {
    console.error("ordersCreate error:", e);
    // Keep webhook green to avoid retries; we log for debugging
    return res.status(200).send("ok");
  }
}
