import { ThemeProvider } from 'widgets';

function LoggingProvider({ children }) {
  return children;
}

export default function RootLayout({ children }) {
  return <ThemeProvider><LoggingProvider>{children}</LoggingProvider></ThemeProvider>;
}
