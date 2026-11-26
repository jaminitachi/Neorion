import { Outlet as Slot } from 'react-router';

function ShellProvider({ children }: { children: unknown }) {
  return <main>{children}</main>;
}
export function Layout({ children }: { children: unknown }) {
  return <ShellProvider>{children}</ShellProvider>;
}
export function Banner() {
  return <header>Banner</header>;
}
function RootContent() {
  return <><Banner /><Slot /></>;
}
export default function Root() {
  return <RootContent />;
}
export function loader() { return null; }
