import type { Request, Response } from "express";
import { createInvoice, verifyIpnSignature} from "./nowpayments.js";
import { getMapping, saveMapping, deleteMapping } from "./storage.js";
import { getOrderById, completeDraftOrMarkPaid } from "./shopify.js";
import { ENV } from "./env.js";


function allowedStatus(status: string): boolean {
  // e.g. "finished" OR "confirmed,finished"
  const reqStatuses = (ENV.NOWPAYMENTS_REQUIRED_STATUS || "finished")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return reqStatuses.includes((status || "").toLowerCase());
}

/**
 * POST /ipn/nowpayments
 * Header: x-nowpayments-sig (hex)
 * Body (classic format): {
 *   payment_id, payment_status, pay_currency, pay_amount, price_amount, price_currency,
 *   order_id, invoice_id, ...
 * }
 */
export async function nowpaymentsIpn(req: Request, res: Response) {
  try {
    // 1) Verify signature
    const sig = req.header("x-nowpayments-sig") || "";
    if (!verifyIpnSignature(req.body, sig)) {
      return res.status(400).send("bad_sig");
    }

    // 2) Parse essentials
    const b = req.body || {};
    const orderId = String(b.order_id || "");
    const status = String(b.payment_status || "");
    const amount = Number(b.price_amount ?? 0);
    const currency = String(b.price_currency || "USD");

    if (!orderId) {
      return res.status(400).send("missing_order_id");
    }

    console.log("IPN begin", { orderId, status });

    // 3) Always persist a mapping row (even if we didn't create the invoice here)
    //    - invoiceUrl unknown on IPN → store empty string (or reuse if you track it elsewhere)
    //    - orderName not provided → store orderId
    await saveMapping(orderId, orderId, "", amount, currency, null);
    console.log("IPN saved mapping");

    // 4) If finished/confirmed, flip Draft → Order (or Mark Paid)
    if (status.toLowerCase() === "finished" || status.toLowerCase() === "confirmed") {
      console.log("IPN completing in Shopify", { orderId });
      const finalId = await completeDraftOrMarkPaid(orderId);
      console.log("IPN completed", { orderId, finalId });
    }

    return res.status(200).send("OK");
  } catch (e: any) {
    console.error("NOWP IPN error:", e?.message || e, { body: req.body, sig: req.header("x-nowpayments-sig") });
    // Always return 200 to NOWPayments so they don’t keep retrying forever; we rely on logs for debugging
    return res.status(200).send("ERR");
  }
}

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

