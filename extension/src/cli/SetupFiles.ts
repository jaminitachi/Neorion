import { readFileSync } from 'node:fs';

export const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

export function read(file: string) {
  try {
    return readFileSync(file);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}
