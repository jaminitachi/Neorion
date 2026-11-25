import { finishUnrelated } from '../../lib/actions';
import { unrelatedHelper } from '../../lib/helpers';

declare const externalCallback: () => void;
declare function runtimeSegment(): string;

function RequestButton({ onDone, segment }: { onDone: () => void; segment: string }) {
  const handle = async () => {
    unrelatedHelper();
    await finishUnrelated();
    onDone();
  };
  return <>
    <button onClick={handle}>Finish</button>
    <button onClick={() => fetch('/api/unrelated')}>Start / Restart</button>
    <button onClick={() => fetch(`/api/family/${segment}`)}>Load family</button>
  </>;
}

export default function Unrelated() {
  return <RequestButton onDone={externalCallback} segment={runtimeSegment()} />;
}
