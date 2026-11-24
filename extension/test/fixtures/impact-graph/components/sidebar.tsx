import { createItem } from '../server/actions';

function Dialog() { return <button onClick={() => createItem('sidebar')}>Create</button>; }
function Switcher() { return <Dialog />; }
export function Sidebar() { return <Switcher />; }
