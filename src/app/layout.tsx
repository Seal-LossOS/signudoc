import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { Suspense } from "react";

import { SundayFrameMessages } from "@/components/layout/sunday-frame-messages";
import { TooltipProvider } from "@/components/ui/tooltip";
import { readAppFrameOrigin } from "@/lib/embed-origin";

import "./globals.css";

const plusJakartaSans = Plus_Jakarta_Sans({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-ui",
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "SignuDoc",
  description:
    "Free e-signature software for small businesses. Upload, send, sign — no enterprise circus required.",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const frameOrigin = readAppFrameOrigin();

  return (
    <html lang="en">
      <body className={`${plusJakartaSans.variable} antialiased`}>
        {/* Read per request on the dynamic pages Sunday frames; a page prerendered at build posts nothing (R-m in Sunday's docs/risks). */}
        {frameOrigin ? (
          <Suspense fallback={null}>
            <SundayFrameMessages frameOrigin={frameOrigin} />
          </Suspense>
        ) : null}
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
