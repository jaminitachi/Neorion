export function loadArticle() { return 'article'; }
export function findArticles() { return ['article']; }
export function loadUser() { return 'user'; }
export function loadUnrelated() { return 'unrelated'; }

export function getStaticProps() { return { props: { article: loadArticle() } }; }
export function getStaticPaths() { return { paths: findArticles(), fallback: false }; }

export function withData(callback, options) {
  return async context => {
    await options.prefetch(context);
    return callback(context);
  };
}
