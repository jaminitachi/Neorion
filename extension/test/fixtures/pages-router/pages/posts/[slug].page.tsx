import { getStoryLayout } from '../../lib/layouts';
import { PageBodyProvider } from '../../lib/shells';
export { getStaticPaths, getStaticProps } from '../../lib/data';
function Story() { return <PageBodyProvider>Story</PageBodyProvider>; }
function Other() { return null; }
Other.PageWrapper = () => <Never />;
const Alias = Story;
Alias.getLayout = getStoryLayout;
export default Story;
