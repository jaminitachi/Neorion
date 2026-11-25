import { Picker, Primitive, Tabs, Tooltip } from 'fixture-primitives';
import { runFallback } from '../../lib/actions';

function TooltipContent() { return <span />; }
function DayOverride() { return <button />; }
function TriggerButton() { return <button />; }
function QuotedContent() { return <output />; }
function UnusedContent() { return <aside />; }
function Panel({ onRun }: { onRun: () => void }) { return <button onClick={onRun}>Run fallback</button>; }
function Trigger(props: { render: unknown }) { return <Primitive {...props} />; }
function QuotedSlot({ 'content': value }: { content: unknown }) { return <Primitive content={value} />; }
function IgnoresContent({ title }: { title: string; content: unknown }) { return <h2>{title}</h2>; }

export default function Fallback() {
  return <>
    <Tooltip content={<TooltipContent />} />
    <Picker components={{ DayButton: DayOverride }} />
    <Trigger render={<TriggerButton />} />
    <QuotedSlot content={<QuotedContent />} />
    <Tabs items={[{ content: <Panel onRun={runFallback} /> }]} />
    <IgnoresContent title="Title" content={<UnusedContent />} />
  </>;
}
