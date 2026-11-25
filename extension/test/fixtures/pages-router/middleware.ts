import { NextResponse } from 'next/server';

export function middleware(req) {
  return NextResponse.rewrite(new URL('/target', req.url));
}

export const config = {
  matcher: [
    '/posts/:slug',
    '/api/auth/signup',
    { source: '/guide/:path*', has: [{ type: 'cookie', key: 'on' }] },
    '/:path*/embed'
  ]
};
