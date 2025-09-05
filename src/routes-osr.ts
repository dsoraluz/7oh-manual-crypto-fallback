// routes-osr.ts
import type { Request, Response } from "express";
import { getOrderById, getOrderByName, safeCompleteDraft } from "./shopify.js";
import { getMapping, saveMapping } from "./storage.js";
import { createInvoice, verifyIpnSignature } from "./nowpayments.js";
import { ENV } from "./env.js";

/** Normalize a possibly-numeric orderId (REST id) into a GraphQL GID for Orders. */
function normalizeOrderId(maybeId: string): string {
  if (!maybeId) return maybeId;
  if (maybeId.startsWith("gid://")) return maybeId;
  if (/^\d+$/.test(maybeId)) return `gid://shopify/Order/${maybeId}`;
  return maybeId; // already a name or something else
}

/** Try hard to resolve an amount/currency from various Shopify money fields. */
function resolveAmountAndCurrency(o: any): { amount: number; currency: string } {
  const money =
    o?.totalOutstandingSet?.shopMoney ??
    o?.totalOutstandingSet?.presentmentMoney ??
    o?.totalPriceSet?.shopMoney ??
    o?.presentmentTotalPriceSet?.presentmentMoney ??
    o?.currentSubtotalPriceSet?.shopMoney ??
    o?.currentSubtotalPriceSet?.presentmentMoney;

  const amount = Number(money?.amount ?? 0);
  const currency = String(
    money?.currencyCode ?? o?.currencyCode ?? o?.currency ?? "USD"
  );
  return { amount, currency };
}

/** Return true only when the order is clearly finished/paid. */
function isClearlyComplete(o: any): boolean {
  const s =
    String(o?.financialStatus || o?.displayFinancialStatus || "")
      .toUpperCase()
      .trim();
  return ["PAID", "PARTIALLY_REFUNDED", "REFUNDED", "VOIDED"].includes(s);
}

// ---------------------------
// GET /osr/invoice-url?orderId=<GID|numeric> OR ?orderName=<#1001>
export async function redirectToInvoice(req: Request, res: Response) {
  try {
    const rawOrderId = (req.query.orderId as string | undefined) || undefined; // may be numeric
    const orderName = (req.query.orderName as string | undefined) || undefined;
    if (!rawOrderId && !orderName) return res.status(400).send("missing orderId or orderName");

    // 0) Try cache FIRST using all keys that could show up in links
    const tryKeys: string[] = [];
    if (rawOrderId) {
      tryKeys.push(rawOrderId);
      tryKeys.push(normalizeOrderId(rawOrderId));
    }
    if (orderName) tryKeys.push(orderName);

    for (const k of tryKeys) {
      const m = await getMapping(k);
      if (m?.invoiceUrl) return res.redirect(302, m.invoiceUrl);
    }

    // 1) Fetch order (normalize numeric id -> GID)
    const idForFetch = rawOrderId ? normalizeOrderId(rawOrderId) : undefined;
    const order = idForFetch ? await getOrderById(idForFetch) : await getOrderByName(orderName!);
    if (!order) return res.status(404).send("order not found");

    // If Shopify says it's paid/voided, show success page.
    if (isClearlyComplete(order)) {
      return res.redirect(
        302,
        `${ENV.APP_URL}/payment-success?order=${encodeURIComponent(order.id)}`
      );
    }

    // 2) Compute amount/currency robustly
    const { amount, currency } = resolveAmountAndCurrency(order);

    // If Shopify can’t give us a positive amount, don’t lie with a success page.
    if (!amount || amount <= 0) {
      return res.status(422).send("order_amount_unknown");
    }

    // 3) Create NOWPayments invoice
    const gid = String(order.id);
    const name = String(order.name);
    const successUrl = `${ENV.APP_URL}/payment-success?order=${encodeURIComponent(gid)}`;
    const cancelUrl = `${ENV.APP_URL}/payment-cancel?order=${encodeURIComponent(gid)}`;
    const invoice = await createInvoice({ orderId: gid, amount, currency, successUrl, cancelUrl });

    // 4) Persist mapping under ALL useful keys so any future link "just works"
    await saveMapping(gid, name, invoice.invoice_url, amount, currency, ENV.SHOP || null);
    await saveMapping(name, name, invoice.invoice_url, amount, currency, ENV.SHOP || null);
    if (rawOrderId) {
      await saveMapping(rawOrderId, name, invoice.invoice_url, amount, currency, ENV.SHOP || null);
    }

    return res.redirect(302, invoice.invoice_url);
  } catch (e) {
    console.error("redirectToInvoice error:", e);
    return res.status(500).send("server_error");
  }
}

// ---------------------------
// POST /osr/invoice-url  (Admin OSR XHR – returns JSON instead of redirect)
export async function orderStatusInvoiceUrl(req: Request, res: Response) {
  try {
    const { orderId: rawOrderId, shop: shopDomain } = (req.body || {}) as {
      orderId?: string;
      shop?: string;
    };
    if (!rawOrderId) return res.status(400).json({ error: "missing orderId" });

    const orderId = normalizeOrderId(rawOrderId);
    const order = await getOrderById(orderId, shopDomain);
    if (!order) return res.status(404).json({ error: "order_not_found" });

    if (isClearlyComplete(order)) {
      // nothing to pay
      return res.json({ invoiceUrl: null, amount: 0, currency: order?.currency || "USD" });
    }

    const { amount, currency } = resolveAmountAndCurrency(order);
    if (!currency) return res.status(404).json({ error: "order_not_found" });
    if (!amount || amount <= 0) return res.json({ invoiceUrl: null, amount, currency });

    // reuse?
    const cached = await getMapping(orderId);
    const sameAmount =
      typeof cached?.expectedAmount === "number" &&
      Math.abs((cached.expectedAmount ?? 0) - amount) < 1e-8 &&
      cached?.currency === currency;

    if (cached?.invoiceUrl && sameAmount) {
      return res.json({
        invoiceUrl: cached.invoiceUrl,
        amount: cached.expectedAmount,
        currency: cached.currency,
      });
    }

    // fresh invoice
    const successUrl = `${ENV.APP_URL}/payment-success?order=${encodeURIComponent(orderId)}`;
    const cancelUrl = `${ENV.APP_URL}/payment-cancel?order=${encodeURIComponent(orderId)}`;

    const invoice = await createInvoice({ orderId, amount, currency, successUrl, cancelUrl });

    await saveMapping(
      orderId,
      (order as any).name,
      invoice.invoice_url,
      amount,
      currency,
      shopDomain || ENV.SHOP || null
    );

    return res.json({ invoiceUrl: invoice.invoice_url, amount, currency });
  } catch (e) {
    console.error("orderStatusInvoiceUrl error:", e);
    return res.status(500).json({ error: "server_error" });
  }
}

// ---------------------------
// POST /ipn/nowpayments  (NOWPayments → us)
export async function nowpaymentsIpn(req: Request, res: Response) {
  try {
    const sig = req.header("x-nowpayments-sig") || "";
    const body = req.body || {};

    // Verify signature first
    if (!verifyIpnSignature(body, sig)) {
      console.warn("IPN bad signature");
      return res.status(400).send("bad_sig");
    }

    const orderId = body.order_id as string | undefined;
    const status = (body.payment_status as string | "").toLowerCase();

    console.log("IPN begin", { orderId, status });

    // Always persist a snapshot mapping (nulls instead of undefined)
    await saveMapping(
      orderId || "unknown",
      String(orderId || "unknown"),
      "",
      Number(body.price_amount ?? 0),
      String(body.price_currency || "USD"),
      null
    );
    console.log("IPN saved mapping");

    // ---- MULTI-STATUS CHECK ----
    const requiredStatuses = (ENV.NOWPAYMENTS_REQUIRED_STATUS || "finished")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!requiredStatuses.includes(status)) {
      console.log("IPN status not final, ignoring:", status, "(required:", requiredStatuses, ")");
      return res.status(200).send("ignored");
    }
    // ----------------------------

    if (!orderId) {
      console.warn("IPN missing order_id");
      return res.status(200).send("missing_order_id");
    }

    // If the id is a DraftOrder, try to complete it; else treat as done
    if (orderId.startsWith("gid://shopify/DraftOrder/")) {
      console.log("IPN completing in Shopify", { orderId });
      const result = await safeCompleteDraft(orderId);

      // Log the full result (success or failure) so we see exactly what Shopify said
      console.log("IPN safeCompleteDraft result", {
        ok: result.ok,
        finalOrderId: (result as any).finalOrderId ?? null,
        userErrors: (result as any).userErrors ?? [],
        graphQLErrors: (result as any).graphQLErrors ?? [],
        rawPresent: Boolean((result as any).raw),
      });

      if (!result.ok) {
        console.error("IPN draft complete failed", {
          orderId,
          err: (result as any).error?.message || (result as any).error,
          graphQLErrors: (result as any).graphQLErrors ?? [],
        });
        // Still return 200 so NOWP doesn't keep retrying forever.
        return res.status(200).send("complete_failed");
      }

      console.log("IPN completed", {
        orderId,
        finalId: (result as any).finalOrderId || "(unknown)",
      });
      return res.status(200).send("OK");
    } else {
      // Already an Order id (or unknown type) → assume already completed
      console.log("IPN order appears already completed or not a DraftOrder:", { orderId });
      return res.status(200).send("already_completed");
    }
  } catch (e) {
    console.error("NOWP IPN fatal", e);
    // Return 200 to stop retries; body says ERR for quick grep in logs.
    return res.status(200).send("ERR");
  }
}

// ---------------------------
// GET /payment-success
export function paymentSuccess(req: Request, res: Response) {
  const order = (req.query.order as string | undefined) || "";
  const storeUrl = ENV.SHOP ? `https://${ENV.SHOP}` : ENV.APP_URL;

  const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"/>
<title>Payment Success</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
         margin: 40px; color:#111; }
  .btn { display:inline-block; padding:10px 16px; border-radius:8px; text-decoration:none;
         border:1px solid #222; font-weight:600; }
  .muted { color:#666; font-size:14px; margin-top:8px; }
</style>
<h1>Thanks — crypto payment received ✅</h1>
<p>We’ll start processing your order shortly.</p>
<p><a class="btn" href="${storeUrl}">Return to store</a></p>
${order ? `<p class="muted">Order reference: <code>${order}</code></p>` : ""}
<p class="muted">You can safely close this tab.</p>
</html>`;
  res.status(200).type("html").send(html);
}

// ---------------------------
// GET /payment-cancel
export function paymentCancel(req: Request, res: Response) {
  const order = (req.query.order as string | undefined) || "";
  // fix: use orderId param so the handler understands it
  const invoiceLink = order
    ? `${ENV.APP_URL}/osr/invoice-url?orderId=${encodeURIComponent(order)}`
    : `${ENV.APP_URL}/`;

  const storeUrl = ENV.SHOP ? `https://${ENV.SHOP}` : ENV.APP_URL;

  const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"/>
<title>Payment Canceled</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
         margin: 40px; color:#111; }
  .row { display:flex; gap:12px; flex-wrap:wrap; }
  .btn { display:inline-block; padding:10px 16px; border-radius:8px; text-decoration:none;
         border:1px solid #222; font-weight:600; }
</style>
<h1>Crypto payment canceled</h1>
<p>No worries — you can reopen your invoice or head back to the store.</p>
<div class="row">
  <a class="btn" href="${invoiceLink}">Reopen Crypto Invoice</a>
  <a class="btn" href="${storeUrl}">Return to store</a>
</div>
</html>`;
  res.status(200).type("html").send(html);
}
