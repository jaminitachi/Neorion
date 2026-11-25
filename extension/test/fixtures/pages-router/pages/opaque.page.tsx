import { createHandler } from 'opaque-framework';
import { loadUser } from '../lib/data';
export const getServerSideProps = createHandler(() => ({ props: { user: loadUser() } }));
export default function OpaquePage() { return <main />; }
