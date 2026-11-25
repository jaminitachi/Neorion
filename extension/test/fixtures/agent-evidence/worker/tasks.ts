import { request } from 'node:https';

export async function runTasks() {
  const base = process.env.APP_ORIGIN;
  const url = `${base}/services/refresh`;
  await fetch(url, { method: 'POST' });
  request('https://example.test/services/refresh', { method: 'POST' }).end();
}

export function ignoreLiteral() {
  return '/services/refresh';
}

export function externalRequest(date: string) {
  return fetch(`https://external.example/${date}/refresh`);
}
