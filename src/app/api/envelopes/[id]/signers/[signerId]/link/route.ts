import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "@/lib/security/request";
import { copySigningLink, SigningLinkError } from "@/lib/signing-link-copy";

type SigningLinkRouteContext = {
  params: Promise<{
    id: string;
    signerId: string;
  }>;
};

// The sender's copy of a signer's link on a link-delivery envelope. Stable
// until ?replace=true, which kills the previous link at once.

export async function POST(request: Request, context: SigningLinkRouteContext) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id, signerId } = await context.params;
  const ipAddress = getClientIpAddress(request.headers);
  const rateLimitResponse = await applyRateLimit({
    category: "signing_link",
    key: buildRateLimitKey(["signing-link", session.user.id, id]),
    limit: 60,
    request,
    userId: session.user.id,
    windowMs: 60 * 60 * 1000,
  });

  if (rateLimitResponse) {
    rateLimitResponse.headers.set("cache-control", "private, no-store");
    return rateLimitResponse;
  }

  const replace = new URL(request.url).searchParams.get("replace") === "true";

  try {
    const link = await copySigningLink({
      actor: {
        email: session.user.email,
        ipAddress,
        userAgent: getRequestUserAgent(request.headers),
      },
      envelopeId: id,
      replace,
      signerId,
      userId: session.user.id,
    });

    return NextResponse.json(link, {
      headers: {
        "cache-control": "private, no-store",
      },
      status: 200,
    });
  } catch (error) {
    if (error instanceof SigningLinkError) {
      return NextResponse.json(
        { error: error.message },
        {
          headers: {
            "cache-control": "private, no-store",
          },
          status: error.statusCode,
        },
      );
    }

    logRouteError(error, {
      category: "signing_link_failure",
      ipAddress,
      message: "Unexpected failure while copying a signing link.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to copy a signing link." },
      {
        headers: {
          "cache-control": "private, no-store",
        },
        status: 500,
      },
    );
  }
}
