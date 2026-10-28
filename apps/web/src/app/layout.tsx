import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "Watch",
  description: "Telegram partner commerce platform"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Telegram sets viewport CSS variables on <html> before React hydrates it.
  return <html lang="ru" suppressHydrationWarning><body><Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />{children}</body></html>;
}
