// src/klaviyo.ts
const TRACK_URL = 'https://a.klaviyo.com/api/track';
import { ENV } from './env.js';

export async function sendInvoiceEventV2(params: {
  email: string;
  orderName: string;
  invoiceUrl: string;
}) {
  const token = ENV.KLAVIYO_PUBLIC_TOKEN!;
  const payload = {
    token,
    event: ENV.KLAVIYO_EVENT_METRIC || 'Crypto Invoice Created',
    customer_properties: {
      $email: params.email,
    },
    properties: {
      order_name: params.orderName,
      invoice_url: params.invoiceUrl,
    },
    time: Math.floor(Date.now() / 1000),
  };

  // v2 Track accepts either GET with ?data=base64 or POST JSON.
  const res = await fetch(TRACK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Klaviyo v2 track failed: ${res.status} ${txt}`);
  }
}
