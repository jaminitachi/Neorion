'use client';
import { service as ledger, plainClient as transport } from './client';

export function InvoicePanel() {
  ledger.invoices.total.useQuery(1);
  ledger.invoices.total.useSuspenseQuery(2);
  ledger['invoices'].list.useInfiniteQuery();
  ledger.invoices.create.useMutation();
  ledger.invoices.changed.useSubscription();
  return null;
}

export function readThroughTransport() {
  return transport.invoices.total.query(1);
}

export function unrelated(ledger: any) {
  ledger.invoices.total.useQuery(1);
}
