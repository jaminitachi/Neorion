import { cache } from 'react';
import { normalize } from '../lib/normalize';

export const getData = cache(async (value: string) => normalize(value));
