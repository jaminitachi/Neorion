'use client';

import { publishPrimary, publishSecondary } from '../lib/actions';

export function Leaf() { return <output />; }
export function IconMark() { return <small />; }
export function UntracedLeaf() { return <output />; }
export function Untouched() { return <aside />; }

export function RenderPanel({ panel, Badge }: { panel?: any; Badge?: any }) {
  return <section>{panel}{Badge && <Badge />}</section>;
}

export function ForwardPanel({ body }: { body: any }) {
  return <RenderPanel panel={body} Badge={IconMark} />;
}

type RequestProps = { endpoint: string; handleSave: () => void; kind: 'primary' | 'secondary' };

export function RequestPanel(props: RequestProps) {
  const { endpoint: url, handleSave } = props;
  const update = () => fetch(url, { method: 'PATCH' });
  const remove = () => fetch(url, { method: 'DELETE' });
  const publish = () => {
    if (props.kind === 'primary') publishPrimary();
    else publishSecondary();
    handleSave();
  };
  return <>
    <button onClick={update}>Update</button>
    <button onClick={remove}>Remove</button>
    <button onClick={publish}>Publish</button>
  </>;
}

export function ForwardRequest({ endpoint, ...props }: RequestProps) {
  return <RequestPanel endpoint={endpoint} handleSave={props.handleSave} kind={props.kind} />;
}

export function ListRow({ id, handleSave }: { id: string; handleSave: () => void }) {
  return <ForwardRequest kind="primary" endpoint={`/api/items/${id}`} handleSave={handleSave} />;
}
