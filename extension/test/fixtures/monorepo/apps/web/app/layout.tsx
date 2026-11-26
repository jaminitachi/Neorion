import { SharedProvider } from "@fixture/ui";

export default function RootLayout({ children }: { children: unknown }) {
  return <SharedProvider>{children}</SharedProvider>;
}
