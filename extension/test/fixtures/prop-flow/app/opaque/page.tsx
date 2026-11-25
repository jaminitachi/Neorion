import { RenderPanel, RequestPanel, UntracedLeaf } from '../../ui/panel';

declare function getProps(): Record<string, unknown>;

export default function OpaquePage() {
  return <>
    <RenderPanel panel={<UntracedLeaf />} {...getProps()} />
    <RequestPanel endpoint="/api/items/opaque" {...getProps()} kind="primary" handleSave={() => {}} />
  </>;
}
