export function OuterProvider({ children }) { return <main>{children}</main>; }
export function LayoutProvider({ children }) { return <section>{children}</section>; }
export function PropertyProvider({ children }) { return <div>{children}</div>; }
export function PageBodyProvider({ children }) { return <div>{children}</div>; }

function StoryLayout(page) { return <LayoutProvider>{page}</LayoutProvider>; }
export default StoryLayout;

export function PropertyWrapper({ Component: Screen, pageProps }) {
  return <PropertyProvider><Screen {...pageProps} /></PropertyProvider>;
}
