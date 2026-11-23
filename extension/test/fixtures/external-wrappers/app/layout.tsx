import { SWRConfig } from 'swr';
import { SessionProvider } from 'next-auth/react';
import Link from 'next/link';
import { Icon, Grid, ThemeContext as Scope, Panel as widgets } from 'widgets';
import { Tabs } from '@radix-ui/react-tabs';
import { motion } from 'framer-motion';

export default function RootLayout({ children }) {
  return <html><body>
    <header><Link href="/"><Icon /></Link></header>
    <motion.div><SWRConfig><Grid value="columns"><Tabs value="a">
      <widgets.Root><SessionProvider><Scope value="theme"><LocalContext value="local">
        <LocalConfig><ContextShell>{children}</ContextShell></LocalConfig>
      </LocalContext></Scope></SessionProvider></widgets.Root>
    </Tabs></Grid></SWRConfig></motion.div>
  </body></html>;
}

function LocalContext({ children }) {
  return <section>{children}</section>;
}

function LocalConfig({ children }) {
  return <section>{children}</section>;
}

const theme = { Provider: null, Consumer: null };
function ContextShell({ children }) {
  return <theme.Provider><theme.Consumer>{children}</theme.Consumer></theme.Provider>;
}
