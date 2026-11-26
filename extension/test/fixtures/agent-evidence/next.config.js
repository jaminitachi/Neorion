const withMdx = require('@next/mdx')();
const config = { pageExtensions: ['ts', 'tsx', 'js', 'jsx', 'mdx'] };
module.exports = withMdx(config);
