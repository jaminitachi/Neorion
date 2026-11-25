import { test, type APIRequestContext, type Page } from '@playwright/test';

const send = (request: APIRequestContext) => request.post('/api/auth/signup');
test('recognized fixture', async ({ request: api }) => {
  await api.get('/api/auth/token');
  await send(api);
});

export function csrf(page: Page) { return page.context().request.get('/api/auth/csrf'); }
