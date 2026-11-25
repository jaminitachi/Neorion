import { RenderPanel, RequestPanel } from '../../ui/panel';

export default function SecondaryPage() {
  return <>
    <RenderPanel panel={<span>Secondary</span>} />
    <RequestPanel endpoint="/api/flags/secondary" kind="secondary" handleSave={() => {}} />
  </>;
}
