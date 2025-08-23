// src/env.ts
import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

// Export strongly-typed env so the rest of the app can use it safely
export const ENV = {
  PORT: Number(process.env.PORT || 8080),
  APP_URL: req('APP_URL'),

  SHOP: req('SHOP'), // e.g. "crypto7ohplus1.myshopify.com"
  SHOPIFY_API_KEY: req('SHOPIFY_API_KEY'),
  SHOPIFY_API_SECRET: req('SHOPIFY_API_SECRET'),
  SHOPIFY_ACCESS_TOKEN: req('SHOPIFY_ACCESS_TOKEN'),

  NOWPAYMENTS_API_KEY: req('NOWPAYMENTS_API_KEY'),
  NOWPAYMENTS_IPN_SECRET: req('NOWPAYMENTS_IPN_SECRET'),

  // optional
  KLAVIYO_PUBLIC_TOKEN: process.env.KLAVIYO_PUBLIC_TOKEN || '',
  KLAVIYO_EVENT_METRIC: process.env.KLAVIYO_EVENT_METRIC || 'Crypto Invoice Created',
};
