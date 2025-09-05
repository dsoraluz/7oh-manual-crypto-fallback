# 7OH Manual Crypto Fallback

## 📌 Overview
This project provides a **manual cryptocurrency payment fallback** for Shopify Plus stores using [NOWPayments](https://nowpayments.io/).  

Since Shopify does not allow direct checkout UI extensions for non-Plus partners (and pixel/scripts are sandboxed on the Thank You page), this service bridges the gap by:

- Creating NOWPayments invoices when an order is placed with the **“Cryptocurrency” manual payment method**.  
- Exposing secure API routes (`/osr/invoice-url`, `/ipn/nowpayments`, etc.) via Google Cloud Run.  
- Option A: Redirecting customers to the invoice (script or button on Thank You page).  
- Option B: Sending the invoice link automatically via **Klaviyo email/SMS**.  

This ensures crypto customers can still pay without breaking Shopify’s restrictions.

---

## ⚙️ Architecture
- **Shopify Manual Payment Button** → customer selects “Cryptocurrency.”  
- **Cloud Run App** (`server.ts`) →  
  - `/osr/invoice-url` → returns or generates NOWPayments invoice for order GID.  
  - `/ipn/nowpayments` → verifies webhook signatures & marks order paid.  
- **Firestore** → stores invoice mappings `{ orderId, invoiceUrl, expectedAmount, currency, shop }`.  
- **Klaviyo Integration (optional, recommended)** → auto-sends “Pay with Crypto” link via email/SMS.

---

## 🔑 Environment Variables
Stored in `.env.cloudrun.yaml` (not committed). Example:

```yaml
APP_URL: "https://manual-crypto-fallback-xxxxx-uc.a.run.app"
SHOPIFY_API_KEY: "..."
SHOPIFY_API_SECRET: "..."
SHOPIFY_ACCESS_TOKEN: "shpat_..."
SHOP: "myshop.myshopify.com"

NOWPAYMENTS_API_KEY: "..."
NOWPAYMENTS_IPN_SECRET: "..."
NOWPAYMENTS_REQUIRED_STATUS: "confirmed,finished"

KLAVIYO_API_KEY: "..."
```

---

## 🚀 Local Development
```bash
# Install dependencies
npm install

# Run locally with ngrok
npm run dev
```

Make sure ngrok is pointed at `localhost:8080` and update `APP_URL` in `.env`.

---

## 🐳 Container & Deployment
Project is designed for **Google Cloud Run**.

### 1. Build image
```bash
gcloud builds submit --tag gcr.io/$PROJECT_ID/manual-crypto-fallback
```

### 2. Deploy
```bash
gcloud run deploy manual-crypto-fallback \
  --image gcr.io/$PROJECT_ID/manual-crypto-fallback \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --env-vars-file ./.env.cloudrun.yaml
```

### 3. Verify
```bash
curl -s "$SERVICE_URL/health"
# should return: ok
```

---

## 🔥 Endpoints

### `POST /osr/invoice-url`
Request:
```json
{
  "orderId": "gid://shopify/Order/1234567890"
}
```

Response:
```json
{
  "invoiceUrl": "https://nowpayments.io/invoice/...",
  "amount": 100.50,
  "currency": "USD"
}
```

### `POST /ipn/nowpayments`
- Consumes NOWPayments webhook.  
- Verifies signature (HMAC SHA-512).  
- Marks Shopify order as paid if status matches `NOWPAYMENTS_REQUIRED_STATUS`.

---

## 📬 Klaviyo Integration (Recommended) - * Not Implemented 
Instead of relying on thank-you page scripts (fragile), we send invoice links via Klaviyo:

1. On `orders/create` with payment method = **Cryptocurrency**, app calls NOWPayments and generates invoice.  
2. Pushes a Klaviyo event:

```ts
await fetch("https://a.klaviyo.com/api/events/", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Klaviyo-API-Key ${ENV.KLAVIYO_API_KEY}`
  },
  body: JSON.stringify({
    data: {
      type: "event",
      attributes: {
        metric: { name: "crypto_invoice_ready" },
        properties: { invoiceUrl, orderId },
        customer_properties: { email: shopifyOrder.email },
        time: new Date().toISOString()
      }
    }
  })
})
```

3. Klaviyo flow triggers → sends customer a branded email/SMS with `{{ event.invoiceUrl }}`.

---

## 📌 Why This Approach
- **UI Extensions / Pixels blocked**: Shopify restricts scripts and extensions on the checkout/thank-you page for non-partners.  
- **App Proxy not allowed**: Would require Plus Partner approval.  
- **Manual Crypto Button (allowed)**: Works, but requires external service to handle invoice creation + notifications.  
- **Klaviyo Flow**: Ensures customer always receives a payment link, even if script doesn’t fire.

---

## 🛠️ Next Steps for Shopify Developer
- Confirm the **manual payment method** is named exactly `"Cryptocurrency"` (or update condition in webhook handler).  
- Decide final flow:  
  - A) Add link/button on Thank You page (already supported).  
  - B) Push to Klaviyo → auto email/SMS (recommended).  
- Harden error handling/logging for production.  
- Style Klaviyo templates for customer-facing flow.  
- Test IPN webhook end-to-end with NOWPayments sandbox → Shopify order should auto-mark as “paid.”

---

## 📉 Costs
- Cloud Run: free tier covers ~2M requests/month.  
- Firestore: free for 50k reads/writes/day.  
- Firebase Hosting: not required if Cloud Run is used.  
- Expected: **$0–10/month** at current scale.

---

## 📖 References
- [NOWPayments API Docs](https://documenter.getpostman.com/view/7907941/S1a32n38)  
- [Shopify Orders API](https://shopify.dev/docs/api/admin-rest/2023-04/resources/order)  
- [Klaviyo Event API](https://developers.klaviyo.com/en/reference/create_client_event)  
- [Google Cloud Run](https://cloud.google.com/run/docs/quickstarts/build-and-deploy)
