import "./env.js";
import express from "express";
import bodyParser from "body-parser";
import { Firestore } from "@google-cloud/firestore";

import { verifyIpnSignature } from "./nowpayments.js";
import { ordersCreate } from "./webhooks.js";
import { markOrderAsPaid, getOrderById } from "./shopify.js";
import { renderPayPage, startPay } from "./routes-pay.js";
import { orderStatusInvoiceUrl, redirectToInvoice, nowpaymentsIpn, paymentSuccess, paymentCancel } from "./routes-osr.js";
import { ENV } from "./env.js";
import { getMapping } from "./storage.js";
import cors from "cors";

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// --- CORS: allow your storefront(s) to call the API from the Thank-You page ---
const ALLOWED_ORIGINS = [
  "https://7ohplus.com",                 // your primary domain
  "https://www.7ohplus.com",             // www variant (if used)
  "https://07907f-40.myshopify.com",     // permanent myshopify domain
  "https://admin.shopify.com"            // sometimes OSR loads in this frame
];

app.use(cors({
  origin(origin, cb) {
    // allow same-origin (server-to-server) and Postman/curl (no origin)
    if (!origin) return cb(null, true);
    // allow any of the domains above
    const ok = ALLOWED_ORIGINS.some(o => origin === o);
    return cb(ok ? null : new Error("CORS: origin not allowed"), ok);
  },
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-shopify-shop-domain", "x-nowpayments-sig"],
  credentials: false, // not using cookies
  maxAge: 600,        // cache preflight for 10 minutes
}));

// Make sure Express can parse JSON before your routes:
app.use(express.json());

// OPTIONAL: explicit preflight handler (helps some proxies)
app.options("*", (req, res) => {
  res.sendStatus(204);
});

// pages
app.get("/pay", renderPayPage);
app.post("/pay/start", startPay);

// health
app.get("/", (_req, res) => res.send("ok"));
app.get("/health", (_req, res) => res.send("ok"));

// osr endpoint (thank-you page fetch)
app.post("/osr/invoice-url", orderStatusInvoiceUrl);
app.get("/osr/invoice-url", redirectToInvoice);

// webhooks
app.post("/webhooks/orders-create", ordersCreate);

// NOWPayments will POST JSON – allow from anywhere or from their IPs if you whitelist.
app.post("/ipn/nowpayments", nowpaymentsIpn);

app.get("/payment-success", paymentSuccess);
app.get("/payment-cancel", paymentCancel);

// NOWPayments Diognastic check
app.get("/diag/nowp", async (_req, res) => {
  try {
    const r = await fetch("https://api.nowpayments.io/v1/status", {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": (ENV.NOWPAYMENTS_API_KEY ?? "").trim(),
      },
    });
    res.status(r.status).send(await r.text());
  } catch (e: any) {
    res.status(500).send(String(e));
  }
});

const db = new Firestore();

app.get("/diag/firestore", async (_req, res) => {
  try {
    const id = "diag-" + Date.now();
    await db.collection("invoiceMappings").doc(id).set({
      orderId: id,
      orderName: "diag",
      invoiceUrl: "",
      expectedAmount: 0,
      currency: "USD",
      createdAt: Date.now(),
    });
    res.send({ ok: true, id });
  } catch (e:any) {
    res.status(500).send({ ok: false, error: String(e) });
  }
});

// // IPN (NOWPayments)
// app.post("/ipn/nowpayments", async (req, res) => {
//   const sig = req.header("x-nowpayments-sig") || null;
//   const valid = verifyIpnSignature(req.body, sig);
//   if (!valid) return res.status(401).send("bad signature");

//   const status = String(
//     req.body.payment_status || req.body.paymentStatus || ""
//   ).toLowerCase();

//   const orderGid = String(req.body.order_id || "");
//   if (!orderGid) return res.status(400).send("missing order id");

//   // pull our mapping for this order
//   const mapping = await getMapping(orderGid);
//   if (!mapping) {
//     console.log("IPN ignored (no mapping; not our manual flow)");
//     return res.sendStatus(200);
//   }

//   // enforce amount
//   const paid = Number(req.body.price_amount ?? req.body.pay_amount ?? 0);
//   if (paid + 1e-8 < mapping.expectedAmount) {
//     console.warn(
//       `IPN amount too low: expected ${mapping.expectedAmount} ${mapping.currency}, got ${paid}`
//     );
//     return res.status(400).send("amount too low");
//   }

//   // only finalize on final statuses you care about
//   if (!["finished", "confirmed"].includes(status)) {
//     return res.sendStatus(200);
//   }

//   // sanity check that Shopify still allows marking paid
//   try {
//     const order = await getOrderById(orderGid, mapping.shop);
//     const dfs: string | undefined = (order as any)?.displayFinancialStatus;
//     if (dfs && !["PENDING", "PARTIALLY_PAID"].includes(dfs)) {
//       console.warn(
//         `Order ${orderGid} cannot be marked paid due to status ${dfs}`
//       );
//       return res.status(400).send("order not payable");
//     }

//     await markOrderAsPaid(orderGid, mapping.shop /* optional */);
//   } catch (e) {
//     console.error("markAsPaid error", e);
//     return res.status(500).send("markAsPaid error");
//   }

//   res.send("ok");
// });

const PORT = Number(ENV.PORT) || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on ${PORT}`);
});

