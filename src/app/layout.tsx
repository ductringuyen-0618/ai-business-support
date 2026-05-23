import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";

import "./globals.css";

export const metadata: Metadata = {
  title: "ai-business-support",
  description:
    "Aggregate Reviews for your Business from external Sources, classify Themes and Incidents, and notify Operators.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className="min-h-screen bg-white text-slate-900 antialiased">{children}</body>
      </html>
    </ClerkProvider>
  );
}
