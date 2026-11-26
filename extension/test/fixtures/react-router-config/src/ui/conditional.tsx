import { Outlet } from 'react-router';
export default function Conditional() {
  return window.location.hash ? <Outlet /> : <p />;
}
