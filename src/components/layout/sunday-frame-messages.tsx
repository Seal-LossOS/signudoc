"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { frameMessageFor } from "@/lib/sunday-frame";

// Posts frameMessageFor's message to the page that frames this one, and
// marks <html> so Sign out hides (Sunday signs people out). Only the
// configured origin can frame these pages (APP_FRAME_ORIGIN, proxy.ts),
// and postMessage's target origin drops the message for any other.
export function SundayFrameMessages({ frameOrigin }: { frameOrigin: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const first = useRef(true);

  useEffect(() => {
    if (window.parent === window) {
      return;
    }

    document.documentElement.dataset.sundayFramed = "";
    window.parent.postMessage(
      frameMessageFor({
        first: first.current,
        pathname,
        search: searchParams.toString(),
      }),
      frameOrigin,
    );
    first.current = false;
  }, [frameOrigin, pathname, searchParams]);

  return null;
}
