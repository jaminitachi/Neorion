import { Form } from 'react-router';
export function action() { return null; }
export default function IndexForm() {
  return <Form method="post" action="?index" />;
}
