import { Providers } from '../../components/providers';
import { Sidebar } from '../../components/sidebar';
import './main.css';

export default function MainLayout({ children }) {
  return <Providers><Sidebar />{children}</Providers>;
}
