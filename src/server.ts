import "./env.js";
import express from "express";
import bodyParser from "body-parser";
// (optional) import cors from "cors";

import { verifyIpnSignature } from "./nowpayments.js";
import { ordersCreate } from "./webhooks.js";
import { markOrderAsPaid, getOrderById } from "./shopify.js";
import { renderPayPage, startPay } from "./routes-pay.js";     // keep if you still use /pay
import { orderStatusInvoiceUrl } from "./routes-osr.js";       // used by Additional scripts flow
import { getMapping } from "./storage.js";
import { ENV } from "./env.js";

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
// app.use(cors({ origin: true, methods: ["GET","POST"] })); // if testing across origins

// (Optional legacy pay page)
app.get("/pay", renderPayPage);
app.post("/pay/start", startPay);

// Health
app.get("/", (_req, res) => res.send("ok"));
app.get("/health", (_req, res) => res.send("ok"));

// Order Status resolver (Additional scripts on Thank-You page calls this)
app.post("/osr/invoice-url", orderStatusInvoiceUrl);

// Shopify webhook(s)
app.post("/webhooks/orders-create", ordersCreate);

// (Optional: keep your stubs if Admin is configured for these)
app.post("/webhooks/orders-paid",  (_req, res) => res.sendStatus(200));
app.post("/webhooks/orders-updated", (_req, res) => res.sendStatus(200));

// NOWPayments IPN
app.post("/ipn/nowpayments", async (req, res) => {
  const sig = req.header("x-nowpayments-sig");
  const valid = verifyIpnSignature(req.body, sig);
  if (!valid) return res.status(401).send("bad signature");

  const status   = String(req.body.payment_status || req.body.paymentstatus || "").toLowerCase();
  const orderGid = req.body.order_id as string;
  if (!orderGid) return res.status(400).send("missing order id");

  // We only act on orders that went through our manual fallback (i.e., mapping exists)
  const mapping = getMapping(orderGid);
  if (!mapping) {
    console.warn(`IPN for ${orderGid} ignored (no mapping; not our flow)`);
    return res.send("ok");
  }

  // Amount guard (as you already had)
  const paid = Number(req.body.price_amount || req.body.pay_amount || 0);
  if (mapping.expectedAmount && paid + 1e-8 < mapping.expectedAmount) {
    console.warn(`IPN amount too low: expected ${mapping.expectedAmount} ${mapping.currency}, got ${paid}`);
    return res.status(400).send("amount too low");
  }

  // Only flip to Paid on final status
  if (["finished", "confirmed"].includes(status)) {
    try {
      // sanity: confirm order is still payable
      const ord = await getOrderById(orderGid);
      const dfs = ord?.displayFinancialStatus; // e.g., PENDING, PARTIALLY_PAID, PAID, REFUNDED, etc.
      if (!["PENDING", "PARTIALLY_PAID"].includes(dfs)) {
        console.warn(`Order ${orderGid} cannot be marked paid due to status ${dfs}`);
        return res.status(409).send("order not payable");
      }

      await markOrderAsPaid(orderGid /*, mapping.shop if you stored it */);
    } catch (e) {
      console.error("markAsPaid error", e);
      return res.status(500).send("markAsPaid error");
    }
  }
  res.send("ok");
});

const PORT = Number(ENV.PORT || 8080);
app.listen(PORT, () => console.log(`manual-crypto-fallback listening on ${PORT}`));
