"use client";

import { useEffect, useState } from "react";

import { isSafeSundayNext, SUNDAY_DEFAULT_NEXT } from "@/lib/auth/sunday-path";

// Where Sunday's handoff lands (product-signatures D4). The token rides in
// the fragment, which no server, log or Referer sees; it is erased from the
// address at once and posted to the bridge, which sets the session.
export default function SundayEnterPage() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get("t") ?? "";
    const next = fragment.get("next") ?? SUNDAY_DEFAULT_NEXT;

    window.history.replaceState(null, "", window.location.pathname);

    if (!token) {
      window.location.replace("/login");
      return;
    }

    void fetch("/api/auth/sunday/enter", {
      body: JSON.stringify({ next, token }),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
    })
      .then(async (response) => {
        const answer = response.ok
          ? ((await response.json()) as { next?: unknown })
          : null;

        // A refusal goes to /login, which tells Sunday to try one fresh handoff.
        window.location.replace(
          answer && isSafeSundayNext(answer.next) ? answer.next : "/login",
        );
      })
      .catch(() => setFailed(true));
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center p-6 text-sm text-(--secondary)">
      {failed
        ? "Couldn't reach SignuDoc. Open Signatures from Sunday again."
        : "Signing you in…"}
    </main>
  );
}
