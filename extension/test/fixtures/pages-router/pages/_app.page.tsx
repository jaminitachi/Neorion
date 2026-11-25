import { appWithTranslation as translate } from 'next-i18next';
import { OuterProvider } from '../lib/shells';

function App(props) {
  const { Component: Screen, pageProps } = props;
  if (pageProps.maintenance) return <Maintenance />;
  const renderLayout = Screen.getLayout ?? (page => page);
  const content = Screen.PageWrapper ? <Screen.PageWrapper {...props} /> : renderLayout(<Screen {...pageProps} />);
  return <OuterProvider>{content}</OuterProvider>;
}

export default translate(App);
