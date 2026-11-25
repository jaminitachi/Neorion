import { PropertyWrapper } from '../../lib/layouts';
import { withData, loadUser, loadUnrelated } from '../../lib/data';

function NewArticle() { return <article />; }
NewArticle.PageWrapper = PropertyWrapper;
NewArticle.getInitialProps = () => ({ user: loadUser() });

export const getServerSideProps = withData(
  () => ({ props: { user: loadUser() } }),
  {
    prefetch() { return loadUser(); },
    ignored() { return loadUnrelated(); }
  }
);
export default NewArticle;
