import "@shopify/shopify-api/adapters/node";
import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api";
import { ENV } from "./env.js";

const api = shopifyApi({
  apiKey: ENV.SHOPIFY_API_KEY,
  apiSecretKey: ENV.SHOPIFY_API_SECRET,
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
  scopes: [],
  hostName: "localhost",
});

// Default shop/token from env (single-store)
const DEFAULT_SHOP = ENV.SHOP;                    // MUST be *.myshopify.com
const ACCESS_TOKEN = ENV.SHOPIFY_ACCESS_TOKEN;

// GraphQL client for a specific shop (falls back to env)
function gqlClientFor(shopDomain?: string) {
  const shop = (shopDomain || DEFAULT_SHOP) as string;
  return new api.clients.Graphql({
    session: { shop, accessToken: ACCESS_TOKEN } as any,
  });
}

export async function getOrderById(orderId: string, shopDomain?: string) {
  const client = gqlClientFor(shopDomain);
  const q = `query($id: ID!) {
    order(id: $id) {
      id
      name
      email
      paymentGatewayNames        # <-- allowed (optional)
      displayFinancialStatus     # <-- good for pre-checks
      totalOutstandingSet { shopMoney { amount currencyCode } }
    }
  }`;
  const data = await client.request(q, { variables: { id: orderId } });
  return (data as any).data.order;
}

export async function getOrderByName(name: string, shopDomain?: string) {
  const client = gqlClientFor(shopDomain);
  const q = `query($query: String!) {
    orders(first: 1, query: $query) {
      edges { node {
        id
        name
        email
        paymentGatewayNames
        displayFinancialStatus
        totalOutstandingSet { shopMoney { amount currencyCode } }
      } }
    }
  }`;
  const data = await client.request(q, { variables: { query: `name:${name}` } });
  const edges = (data as any).data.orders.edges;
  return edges?.length ? edges[0].node : null;
}

export async function addOrderNoteAttribute(orderId: string, key: string, value: string, shopDomain?: string) {
  const client = gqlClientFor(shopDomain);
  const mutation = `mutation($id: ID!, $note: String!) {
    orderUpdate(input: { id: $id, note: $note }) {
      order { id name note }
      userErrors { field message }
    }
  }`;
  const note = `${key}: ${value}`;
  const result = await client.request(mutation, { variables: { id: orderId, note } });
  const errors = (result as any).data?.orderUpdate?.userErrors;
  if (errors?.length) throw new Error("Shopify error: " + JSON.stringify(errors));
  return (result as any).data?.orderUpdate?.order;
}

export async function markOrderAsPaid(orderGid: string, shopDomain?: string) {
  const client = gqlClientFor(shopDomain);
  const m = `mutation($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order { id displayFinancialStatus }
      userErrors { field message }
    }
  }`;
  const res = await client.request(m, { variables: { input: { id: orderGid } } });
  const errs = (res as any).data?.orderMarkAsPaid?.userErrors;
  if (errs?.length) throw new Error("Shopify userErrors: " + JSON.stringify(errs));
  return (res as any).data.orderMarkAsPaid.order as { id: string; displayFinancialStatus: string };
}
