'use server';

type Handler = () => Promise<void>;
const wrap = (action: Handler) => action;
const makeWrapper = () => wrap;

export const submit = wrap(async () => {});
export const save = ((makeWrapper()(async () => {}) as Handler) satisfies Handler);
export const discard = (async () => {}) satisfies Handler;
export function signOut() { return Promise.resolve(); }
export async function unused() {}

export interface Options { confirm: boolean }
export type Result = void;
export const literal = 42;
const typeOnly = wrap(async () => {});
export type { typeOnly };

export { reexported } from '../lib/reex';
import { plainHelper } from '../lib/reex';
export { plainHelper };
export default async function defAct() {}

const cond = Date.now() > 0;
export const picked = cond ? async () => {} : async () => {};
export const mixed = cond ? async () => {} : null;

async function helper() {}
export { helper };
