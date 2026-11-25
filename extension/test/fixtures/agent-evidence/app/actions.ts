'use server';

export async function sendResource(file: File) {
  return file.name;
}
