import dynamic from 'next/dynamic';
import { CreateItem } from '../../../components';

const Chart = dynamic(() => import('../../../components/chart').then(module => module.Chart));
const empty = true;

export default function Items() {
  return <main>{empty && <CreateItem />}<Chart /></main>;
}
