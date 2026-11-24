import { normalize } from '../../../../lib/normalize';
import { initTRPC } from '@trpc/server';

export function GET() { return Response.json(normalize('foo')); }
export function POST() { return Response.json(Boolean(initTRPC)); }
