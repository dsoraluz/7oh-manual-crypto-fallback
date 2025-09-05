// src/storage.ts
import { Firestore } from "@google-cloud/firestore";

// shape we store
export type InvoiceMapping = {
  orderId: string;        // original GID (gid://shopify/...)
  orderName: string;
  invoiceUrl: string;
  expectedAmount: number;
  currency: string;
  shop?: string | null;
  createdAt: number;      // client-side timestamp kept for compatibility
};

// One Firestore client per container
const db = new Firestore({ ignoreUndefinedProperties: true });

// Collection name – change if you like
const COL = "invoiceMappings";

// ----- helpers -----
// Encode the orderId (GID) into a Firestore-safe doc id (no slashes)
const toDocId = (orderId: string) =>
  Buffer.from(String(orderId), "utf8").toString("base64url");

export async function saveMapping(
  orderId: string,
  orderName: string,
  invoiceUrl: string,
  expectedAmount: number,
  currency: string,
  shop?: string | null
) {
  const doc: InvoiceMapping = {
    orderId,
    orderName,
    invoiceUrl: invoiceUrl ?? "",
    expectedAmount: Number.isFinite(expectedAmount) ? expectedAmount : 0,
    currency: currency || "USD",
    shop: shop ?? null, // use null (not undefined) to keep Firestore happy
    createdAt: Date.now(),
  };
  await db.collection(COL).doc(toDocId(orderId)).set(doc, { merge: true });
  return doc;
}

/** Get a mapping by orderId (GID). Returns undefined if not found. */
export async function getMapping(
  orderId: string
): Promise<InvoiceMapping | undefined> {
  const snap = await db.collection(COL).doc(toDocId(orderId)).get();
  return snap.exists ? (snap.data() as InvoiceMapping) : undefined;
}

/** Optional: delete mapping after payment success (keeps collection tidy). */
export async function deleteMapping(orderId: string) {
  await db.collection(COL).doc(toDocId(orderId)).delete();
}
