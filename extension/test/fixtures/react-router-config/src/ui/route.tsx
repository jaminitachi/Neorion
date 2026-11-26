import { Link as Go, NavLink, useNavigate, Form, useFetcher, useSubmit, useRouteLoaderData } from 'react-router';
export { load as loader } from './data';

export function action() { return null; }
export function clientLoader() { return null; }
export const clientAction = () => null;
export const meta = () => [];
export const links = () => [];
export const headers = () => ({});
export function ErrorBoundary() { return <p>error</p>; }
export function HydrateFallback() { return <p>loading</p>; }

export default function RegisteredPage() {
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const { load: tryLoad } = fetcher;
  const submit = useSubmit();
  const data = useRouteLoaderData('root');
  const LocalLink = (_: { to: string }) => <span>local</span>;
  return <>
    <Go to=".." />
    <Go to="../left" relative="path" />
    <NavLink to={{ pathname: "/receiver" }} />
    <LocalLink to="/false-link" />
    <Form method="post" />
    <fetcher.Form method="post" action="/receiver" />
    <button onClick={() => navigate('/Case')}>go</button>
    <button onClick={() => tryLoad('/receiver')}>load</button>
    <button onClick={() => fetcher.submit({}, { action: '/receiver', method: 'patch' })}>patch</button>
    <button onClick={() => submit({}, { action: '/receiver', method: 'post' })}>submit</button>
  </>;
}
