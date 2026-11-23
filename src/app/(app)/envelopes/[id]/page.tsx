import {
  EnvelopeDetailShell,
  type EnvelopeDeletionNotice,
} from "@/components/envelopes/envelope-detail-shell";
import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import { readEnvelopeDelivery } from "@/lib/delivery";
import {
  formatEnvelopeOwner,
  resolveEnvelopeViewerAccess,
} from "@/lib/envelope-access";
import { getScheduledEnvelopeDeletion } from "@/lib/envelope-deletion";
import { getEnvelopeDetailDataForUser } from "@/lib/envelopes";
import { isEmailOff } from "@/lib/services/email";

const deletionDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});

type EnvelopeDetailPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function EnvelopeDetailPage({
  params,
}: EnvelopeDetailPageProps) {
  const { id } = await params;

  let detailRecord: Awaited<ReturnType<typeof getEnvelopeDetailDataForUser>> =
    null;
  let initialState: "error" | "not-found" | undefined;
  let canDeleteFinished = false;
  let ownerLabel: string | undefined;
  let ownerListView: "all" | "team" = "all";
  let scheduledDeletion: EnvelopeDeletionNotice | undefined;
  let signingLinks = false;

  try {
    const session = await getAuthSession();
    // Its sender's, or, once sent, a teammate's or any administrator's.
    const access = session
      ? await resolveEnvelopeViewerAccess(session.user.id, id, getDb())
      : null;

    detailRecord = access
      ? await getEnvelopeDetailDataForUser(access.ownerUserId, id, getDb())
      : null;
    initialState = detailRecord ? undefined : "not-found";
    ownerLabel =
      access && !access.viewerIsOwner ? formatEnvelopeOwner(access) : undefined;
    // Only an administrator may delete a finished envelope.
    canDeleteFinished =
      detailRecord !== null &&
      session !== null &&
      (await isAdminUser(session.user.id, getDb()));
    // Back to everyone's envelopes for an administrator, to the team's
    // for a teammate.
    ownerListView = canDeleteFinished ? "all" : "team";

    // The sender copies each signer's link: always on a link envelope, and
    // on an emailed one while email is off, so its next signer is not
    // stranded (signing-link-copy.ts allows the same).
    const delivery =
      detailRecord && access?.viewerIsOwner
        ? await readEnvelopeDelivery(id, getDb())
        : null;

    signingLinks =
      delivery === "link" || (delivery === "email" && isEmailOff());

    const scheduled = detailRecord
      ? await getScheduledEnvelopeDeletion(id, getDb())
      : null;

    scheduledDeletion = scheduled
      ? {
          deleteOnLabel: deletionDateFormatter.format(
            new Date(scheduled.deleteAfter * 1000),
          ),
          // Why is for administrators; the sender is told who asked.
          reason: canDeleteFinished ? scheduled.reason : null,
          requestedByEmail: scheduled.requestedByEmail,
        }
      : undefined;
  } catch {
    initialState = "error";
  }

  return (
    <EnvelopeDetailShell
      canDeleteFinished={canDeleteFinished}
      envelopeId={id}
      initialState={initialState}
      key={id}
      ownerLabel={ownerLabel}
      ownerListView={ownerListView}
      record={detailRecord ?? undefined}
      scheduledDeletion={scheduledDeletion}
      signingLinks={signingLinks}
    />
  );
}
