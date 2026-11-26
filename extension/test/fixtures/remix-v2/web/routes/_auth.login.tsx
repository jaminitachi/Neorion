import { Form, Link, useFetcher } from '@remix-run/react';
import { redirect } from '@remix-run/node';
export function loader() { return null; }
export function clientLoader() { return null; }
export function action() { return redirect('/feed.xml'); }
export function clientAction() { return null; }
export default function Login() {
  const remote = useFetcher();
  return <>
    <Form method="post" />
    <Link to="/docs" />
    <button onClick={() => remote.load('/feed.xml')}>feed</button>
  </>;
}
