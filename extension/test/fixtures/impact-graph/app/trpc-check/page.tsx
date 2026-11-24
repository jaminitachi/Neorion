import { InvoicePanel } from '../../components/trpc/panel';
import { billingRouter, createCaller as getCaller } from '../../server/trpc-routes';

export function readThroughRouter() {
  return billingRouter.createCaller({}).invoices.total(1);
}

export function writeThroughFactory() {
  const caller = getCaller({});
  return caller.invoices.create();
}

export default function TrpcCheckPage() {
  void readThroughRouter();
  void writeThroughFactory();
  return <InvoicePanel />;
}
