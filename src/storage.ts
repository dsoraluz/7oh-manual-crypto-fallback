// src/storage.ts
type MapValue = {
  orderName: string;
  invoiceUrl: string;
  expectedAmount?: number;
  currency?: string;
  createdAt: number;
};

const mem = new Map<string, MapValue>();

export function saveMapping(
  orderId: string,
  orderName: string,
  invoiceUrl: string,
  expectedAmount?: number,
  currency?: string
) {
  mem.set(orderId, { orderName, invoiceUrl, expectedAmount, currency, createdAt: Date.now() });
}

export function getMapping(orderId: string) {
  return mem.get(orderId) || null;
}
