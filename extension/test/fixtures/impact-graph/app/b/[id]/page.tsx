import { useItems } from '../../../hooks/use-items';
import { getData } from '../../../server/data';

export function generateMetadata() { return getData('title'); }
export default async function Bio() { useItems(); return <main>{await getData('body')}</main>; }
