import { Suspense } from 'react';
import { ForwardPanel, Leaf, ListRow } from '../../ui/panel';
import { persistRecord } from '../../lib/helpers';

function Busy() { return <span>Loading</span>; }

export default function PrimaryPage() {
  return <>
    <ForwardPanel body={<Leaf />} />
    <Suspense fallback={<Busy />}><span>Ready</span></Suspense>
    <section><h2>Active</h2><ListRow id="active" handleSave={persistRecord} /></section>
    <section><h2>Pending</h2><ListRow id="pending" handleSave={persistRecord} /></section>
  </>;
}
