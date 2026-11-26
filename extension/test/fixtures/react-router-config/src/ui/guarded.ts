export function action({ request }: { request: Request }) {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  return new Response('ok');
}
