'use client';

import { useStatus as readStatus } from '@/hooks/use-status';

export const Status = () => <LocalLabel text={readStatus()} />;

function LocalLabel({ text }: { text: string }) {
  return <p>{text}</p>;
}
