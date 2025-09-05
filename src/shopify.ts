// shopify.ts
import "@shopify/shopify-api/adapters/node";
import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api";
import { ENV } from "./env.js";

const base = shopifyApi({
  apiKey: ENV.SHOPIFY_API_KEY,
  apiSecretKey: ENV.SHOPIFY_API_SECRET,
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
  scopes: [],
  hostName: "localhost",
});

function graphqlClient(shopOverride?: string) {
  const session = {
    shop: (shopOverride || ENV.SHOP) as string,
    accessToken: ENV.SHOPIFY_ACCESS_TOKEN as string,
  } as any;
  return new base.clients.Graphql({ session });
}

/** Works for BOTH DraftOrder and Order ids. Returns normalized {amount,currency}. */
export async function getOrderById(id: string, shopOverride?: string) {
  const client = graphqlClient(shopOverride);

  const q = /* GraphQL */ `
    query GetForInvoice($id: ID!) {
      node(id: $id) {
        id
        __typename
        ... on DraftOrder {
          name
          totalPriceSet { shopMoney { amount currencyCode } }
          displayFinancialStatus
        }
        ... on Order {
          name
          totalOutstandingSet { shopMoney { amount currencyCode } }
          financialStatus
          displayFinancialStatus
        }
      }
    }
  `;

  const res = (await client.request(q, { variables: { id } })) as any;
  const node = res?.data?.node;
  if (!node) return null;

  // normalize
  let amount = 0;
  let currency: string | undefined;
  if (node.__typename === "DraftOrder") {
    amount = Number(node?.totalPriceSet?.shopMoney?.amount ?? 0);
    currency = node?.totalPriceSet?.shopMoney?.currencyCode;
  } else {
    amount = Number(node?.totalOutstandingSet?.shopMoney?.amount ?? 0);
    currency = node?.totalOutstandingSet?.shopMoney?.currencyCode;
  }

  return { ...node, amount, currency };
}

/** Look up by name; supports '#1001' (Order) and 'D247' (DraftOrder) */
export async function getOrderByName(name: string, shopOverride?: string) {
  const client = graphqlClient(shopOverride);

  // Orders search (remove statusUrl to avoid GraphQL error)
  const ordersQ = /* GraphQL */ `
    query($query: String!) {
      orders(first: 1, query: $query) {
        edges {
          node {
            id
            name
            email
            displayFinancialStatus
            totalOutstandingSet { shopMoney { amount currencyCode } }
          }
        }
      }
    }
  `;
  const orders = (await client.request(ordersQ, { variables: { query: `name:${name}` } })) as any;
  const orderEdge = orders?.data?.orders?.edges?.[0];
  if (orderEdge) return orderEdge.node;

  // DraftOrders search (names like D247)
  const draftsQ = /* GraphQL */ `
    query($query: String!) {
      draftOrders(first: 1, query: $query) {
        edges {
          node {
            id
            name
            invoiceUrl
            displayFinancialStatus
            totalOutstandingSet { shopMoney { amount currencyCode } }
          }
        }
      }
    }
  `;
  const drafts = (await client.request(draftsQ, { variables: { query: `name:${name}` } })) as any;
  const draftEdge = drafts?.data?.draftOrders?.edges?.[0];
  return draftEdge ? draftEdge.node : null;
}

/** Still valid for real Orders; will throw if called with a DraftOrder id. */
export async function markOrderAsPaid(orderId: string, shopOverride?: string) {
  const client = graphqlClient(shopOverride);
  const mutation = /* GraphQL */ `
    mutation markPaid($id: ID!) {
      orderMarkAsPaid(input: { id: $id }) {
        order { id displayFinancialStatus }
        userErrors { field message }
      }
    }
  `;
  const res = (await client.request(mutation, { variables: { id: orderId } })) as any;
  const errs = res?.data?.orderMarkAsPaid?.userErrors;
  if (errs?.length) throw new Error("Shopify userErrors: " + JSON.stringify(errs));
  return res?.data?.orderMarkAsPaid?.order;
}

// COMPLETE draft or MARK PAID order based on the id's type
export async function completeDraftOrMarkPaid(id: string, shopOverride?: string) {
  const session = {
    shop: shopOverride || ENV.SHOP,
    accessToken: ENV.SHOPIFY_ACCESS_TOKEN,
  } as any;
  const client = new base.clients.Graphql({ session });

  if (id.startsWith("gid://shopify/DraftOrder/")) {
    const m = /* GraphQL */ `
      mutation completeDraft($id: ID!) {
        draftOrderComplete(id: $id, paymentPending: false) {
          draftOrder { id }
        }
      }
    `;
    const res = (await client.request(m, { variables: { id } })) as any;
    const errs = res?.data?.draftOrderComplete?.userErrors;
    if (errs?.length) throw new Error("draftOrderComplete " + JSON.stringify(errs));
    return res?.data?.draftOrderComplete?.draftOrder?.order?.id as string | undefined;
  }

  if (id.startsWith("gid://shopify/Order/")) {
    const m = /* GraphQL */ `
      mutation markPaid($id: ID!) {
        orderMarkAsPaid(input: { id: $id }) {
          order { id }
          userErrors { field message }
        }
      }
    `;
    const res = (await client.request(m, { variables: { id } })) as any;
    const errs = res?.data?.orderMarkAsPaid?.userErrors;
    if (errs?.length) throw new Error("orderMarkAsPaid " + JSON.stringify(errs));
    return res?.data?.orderMarkAsPaid?.order?.id as string | undefined;
  }

  throw new Error("Unknown Shopify GID type: " + id);
}

export async function completeDraftOrder(
  draftOrderId: string,
  paymentPending = false,
  shopOverride?: string
) {
  const session = {
    shop: shopOverride || ENV.SHOP,
    accessToken: ENV.SHOPIFY_ACCESS_TOKEN,
  } as any;
  const client = new base.clients.Graphql({ session });

  const m = /* GraphQL */ `
    mutation($id: ID!, $pending: Boolean!) {
      draftOrderComplete(id: $id, paymentPending: $pending) {
        draftOrder { id name }
        order      { id name }
        userErrors { field message }
      }
    }
  `;

  const resp = await client.request(m, {
    variables: { id: draftOrderId, pending: paymentPending },
  });

  const payload = (resp as any)?.data?.draftOrderComplete;
  const errs = payload?.userErrors;
  if (errs?.length) {
    throw new Error("Shopify userErrors: " + JSON.stringify(errs));
  }
  return {
    draftOrder: payload?.draftOrder,
    order: payload?.order,
  };
}

export async function safeCompleteDraft(draftGid: string, shopOverride?: string) {
  const session = {
    shop: shopOverride || ENV.SHOP,
    accessToken: ENV.SHOPIFY_ACCESS_TOKEN,
  } as any;
  const client = new base.clients.Graphql({ session });

  const mutation = /* GraphQL */ `
    mutation($id: ID!) {
      draftOrderComplete(id: $id, paymentPending: false) {
        draftOrder { id }
        order { id name }
        userErrors { field message }
      }
    }
  `;

  try {
    const res = await client.request(mutation, { variables: { id: draftGid } });
    const payload = (res as any)?.data?.draftOrderComplete;
    const uerrs = payload?.userErrors || [];
    if (uerrs.length) {
      console.warn("draftOrderComplete userErrors:", uerrs);
    }
    const finalOrderId = payload?.order?.id || null;
    return { ok: true, finalOrderId, userErrors: uerrs, raw: res };
  } catch (err: any) {
    const gErrs = err?.graphQLErrors || err?.response?.body?.errors?.graphQLErrors || [];
    if (gErrs.length) {
      console.warn("draftOrderComplete graphQLErrors:", gErrs);
      const msg = String(gErrs[0]?.message || "");
      if (
        msg.toLowerCase().includes("already") ||
        msg.toLowerCase().includes("not open") ||
        msg.toLowerCase().includes("closed") ||
        msg.toLowerCase().includes("completed")
      ) {
        return { ok: true, finalOrderId: null, userErrors: gErrs };
      }
    }
    return { ok: false, error: err, graphQLErrors: gErrs };
  }
}
