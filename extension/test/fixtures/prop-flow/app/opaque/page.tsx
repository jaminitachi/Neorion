import { RenderPanel, UntracedLeaf } from '../../ui/panel';

declare function getProps(): Record<string, unknown>;

export default function OpaquePage() {
  return <RenderPanel panel={<UntracedLeaf />} {...getProps()} />;
}
