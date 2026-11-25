module.exports = {
  pageExtensions: ['page.tsx', 'page.ts'],
  basePath: '/base',
  i18n: { locales: ['en', 'ko'], defaultLocale: 'en' },
  async redirects() {
    return [{ source: '/redirect', destination: '/target', permanent: false }];
  }
};
