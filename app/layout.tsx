import type { Metadata } from "next";
import { Inter_Tight } from "next/font/google";
import "./globals.css";

const interTight = Inter_Tight({
  variable: "--font-inter-tight",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const title = "RooWatch - Instant lead generation";
const description =
  "RooWatch watches the Facebook groups your customers already use and alerts you to the posts worth replying to.";
// The square mascot, 400 by 400, already in /public.
const shareImage = { url: "/roowatch-mascot-3d.png", width: 400, height: 400, alt: "RooWatch mascot" };

export const metadata: Metadata = {
  // Share previews need full image links. This turns /roowatch-mascot-3d.png into one.
  metadataBase: new URL("https://roowatch.com.au"),
  title,
  description,
  openGraph: {
    title,
    description,
    siteName: "RooWatch",
    locale: "en_AU",
    type: "website",
    images: [shareImage],
  },
  twitter: {
    card: "summary",
    title,
    description,
    images: [shareImage],
  },
  icons: {
    icon: [
      { url: "/favicon.svg?v=2", type: "image/svg+xml" },
      { url: "/favicon.png?v=2", type: "image/png" },
    ],
    shortcut: "/favicon.png?v=2",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en-AU">
      <body className={interTight.variable}>
        {children}
      </body>
    </html>
  );
}
