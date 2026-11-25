import { redirect as leave } from 'next/navigation';
import { ResourcePanel, ResourceRow } from '../ui/panel';

export default function Page({ enabled, ready, items, useAlternate }) {
  if (!enabled) leave('/setup');
  if (!ready) return null;
  if (useAlternate) return <ResourceRow />;
  return <ResourcePanel items={items} />;
}
