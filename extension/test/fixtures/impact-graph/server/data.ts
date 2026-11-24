import { cache } from 'react';
import { normalize } from '../lib/normalize';

const DATA_SUFFIX = '';
export const getData = cache(async (value: string) => normalize(value + DATA_SUFFIX));
