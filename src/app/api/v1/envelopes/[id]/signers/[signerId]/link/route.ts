import { apiJson } from "@/lib/api/http";
import {
  API_SIGNING_LINK_LIMIT,
  applyAccountLimit,
  handleApi,
} from "@/lib/api/route";
import { copySigningLink } from "@/lib/signing-link-copy";

type RouteContext = { params: Promise<{ id: string; signerId: string }> };

// A signing link for a signer of a link-delivery envelope, stable until
// replaced (?replace=true). See docs/api.md, "Link delivery".

export async function POST(request: Request, context: RouteContext) {
  return handleApi(
    request,
    "write",
    "api_signing_link_failure",
    async (api) => {
      const limited = await applyAccountLimit(api, API_SIGNING_LINK_LIMIT);

      if (limited) {
        return limited;
      }

      const { id, signerId } = await context.params;
      const replace =
        new URL(request.url).searchParams.get("replace") === "true";

      const link = await copySigningLink({
        actor: {
          apiKeyId: api.actor.apiKeyId,
          email: api.actor.email,
          ipAddress: api.actor.ipAddress,
          userAgent: api.actor.userAgent,
        },
        envelopeId: id,
        replace,
        signerId,
        userId: api.actor.userId,
      });

      return apiJson({ ...link, object: "signing_link" }, { status: 200 });
    },
  );
}
