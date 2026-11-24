import { normalize } from '../lib/normalize';
import { procedure } from './trpc';
export const create = procedure.input('string').mutation(async value => normalize(value));
