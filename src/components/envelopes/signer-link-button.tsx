"use client";

import { CopyIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ShellButton } from "@/components/shared/form-shell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Copy link and New link for one signer of an envelope whose sender delivers
// the signing links. The clipboard write starts inside the press, with the
// link still on its way, because Safari refuses a write that starts after an
// await. Where the browser has no ClipboardItem or refuses, the link shows in
// a selected field to copy by hand.

type SignerLinkButtonProps = {
  envelopeId: string;
  signerId: string;
  signerName: string;
  status: "declined" | "pending" | "signed" | "waiting";
};

type CopyState =
  | { kind: "copied" }
  | { kind: "error"; message: string }
  | { kind: "idle" }
  | { kind: "manual"; url: string };

const defaultErrorMessage = "Couldn't get the link. Please try again.";

class LinkRequestError extends Error {}

async function requestLink(
  envelopeId: string,
  signerId: string,
  replace: boolean,
): Promise<string> {
  const response = await fetch(
    `/api/envelopes/${encodeURIComponent(envelopeId)}/signers/${encodeURIComponent(signerId)}/link${replace ? "?replace=true" : ""}`,
    { method: "POST" },
  );
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    url?: string;
  } | null;

  if (!response.ok || typeof payload?.url !== "string") {
    throw new LinkRequestError(payload?.error ?? defaultErrorMessage);
  }

  return payload.url;
}

/** Starts the clipboard write now; false when the browser can't or won't. */
async function writeToClipboard(link: Promise<string>): Promise<boolean> {
  if (
    typeof ClipboardItem === "undefined" ||
    typeof navigator.clipboard?.write !== "function"
  ) {
    return false;
  }

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": link.then(
          (url) => new Blob([url], { type: "text/plain" }),
        ),
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

export function SignerLinkButton({
  envelopeId,
  signerId,
  signerName,
  status,
}: SignerLinkButtonProps) {
  const [copyState, setCopyState] = useState<CopyState>({ kind: "idle" });
  const [isWorking, setIsWorking] = useState(false);
  const [isConfirmingNew, setIsConfirmingNew] = useState(false);
  const manualFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (copyState.kind === "manual") {
      manualFieldRef.current?.focus();
      manualFieldRef.current?.select();
    }
  }, [copyState]);

  if (status === "pending") {
    return <p className="text-xs text-(--tertiary)">Not their turn yet</p>;
  }

  if (status !== "waiting") {
    return null;
  }

  // Called straight from a click: nothing may be awaited before the
  // clipboard write begins.
  function copyLink(replace: boolean) {
    if (isWorking) {
      return;
    }

    setIsWorking(true);
    setCopyState({ kind: "idle" });

    const link = requestLink(envelopeId, signerId, replace);
    const written = writeToClipboard(link);

    void (async () => {
      try {
        const url = await link;

        setCopyState(
          (await written) ? { kind: "copied" } : { kind: "manual", url },
        );
      } catch (error) {
        setCopyState({
          kind: "error",
          message:
            error instanceof LinkRequestError
              ? error.message
              : defaultErrorMessage,
        });
      } finally {
        setIsWorking(false);
      }
    })();
  }

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <div className="flex items-center gap-2">
        <button
          className="btn-quiet inline-flex items-center gap-1.5"
          disabled={isWorking}
          onClick={() => copyLink(false)}
          type="button"
        >
          <CopyIcon aria-hidden="true" className="size-3.5" strokeWidth={2.4} />
          Copy link
        </button>
        <button
          className="btn-quiet inline-flex items-center gap-1.5"
          disabled={isWorking}
          onClick={() => {
            setCopyState({ kind: "idle" });
            setIsConfirmingNew(true);
          }}
          type="button"
        >
          <RefreshCwIcon
            aria-hidden="true"
            className="size-3.5"
            strokeWidth={2.4}
          />
          New link
        </button>
      </div>

      <p
        aria-live="polite"
        className="text-xs text-(--secondary)"
        role="status"
      >
        {copyState.kind === "copied" ? "Copied" : ""}
      </p>

      {copyState.kind === "manual" ? (
        <label className="grid w-full gap-1 sm:w-72">
          <span className="text-xs text-(--secondary)">
            Copy {signerName}&apos;s link:
          </span>
          <input
            className="field-input text-xs"
            onFocus={(event) => event.currentTarget.select()}
            readOnly
            ref={manualFieldRef}
            value={copyState.url}
          />
        </label>
      ) : null}

      {copyState.kind === "error" ? (
        <p className="text-xs text-(--danger)" role="alert">
          {copyState.message}
        </p>
      ) : null}

      {isConfirmingNew ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setIsConfirmingNew(false);
            }
          }}
        >
          <DialogContent className="max-w-md sm:p-8" showCloseButton={false}>
            <div className="space-y-4">
              <DialogHeader className="space-y-3">
                <DialogTitle>Make a new link for {signerName}?</DialogTitle>
                <DialogDescription>
                  The link you already sent stops working.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
                <ShellButton
                  onClick={() => setIsConfirmingNew(false)}
                  variant="secondary"
                >
                  Cancel
                </ShellButton>
                <ShellButton
                  onClick={() => {
                    setIsConfirmingNew(false);
                    copyLink(true);
                  }}
                  variant="danger"
                >
                  Copy new link
                </ShellButton>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
