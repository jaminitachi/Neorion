import { normalize } from '../../../../lib/normalize';

export function GET() { return Response.json(normalize('foo')); }
export function POST() { return Response.json('created'); }
