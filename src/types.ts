export interface InvoiceMapping {
  orderName: string;
  invoiceUrl: string;
  expectedAmount: number;   // in shop currency
  currency: string;         // e.g. "USD"
  shop?: string;            // optional myshopify domain, if you store it
  createdAt: number;        // epoch ms
}
