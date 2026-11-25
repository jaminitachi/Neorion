import NextLink from 'next/link';
import { useRouter as useNextRouter } from 'next/router';

export default function Home({ slug, destination }) {
  const router = useNextRouter();
  const alias = router;
  function go() { alias.push({ pathname: '/guide' }, '/displayed'); }
  function shadow(router) { router.push('/excluded'); }
  return <main>
    <button onClick={go}>Guide</button>
    <button onClick={shadow}>Other</button>
    <NextLink href={`/posts/${slug}`}>Article</NextLink>
    <NextLink href="/target">Target</NextLink>
    <NextLink href={destination}>Unknown</NextLink>
  </main>;
}
