'use client';
import { service as rpc } from '../../components/trpc/client';

export default function CachePage() {
  const utils = rpc.useUtils();
  utils.invoices.total.invalidate();
  utils.invoices.total.fetch(1);
  utils.invoices.total.ensureData(1);
  utils.invoices.total.prefetch(1);
  utils.history.total.invalidate();
  return null;
}
