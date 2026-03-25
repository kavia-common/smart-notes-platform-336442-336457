import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Smart Notes",
  description:
    "A modern notes application with tags, search, and autosave (Smart Notes Platform).",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
