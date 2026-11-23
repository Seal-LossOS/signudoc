import type { BetterAuthPlugin, User } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";

import { getDb, queryOne } from "../db/connection.ts";
import { getRequestClient } from "../security/request.ts";
import { recordSystemAuditEvent } from "../services/system-audit.ts";
import type { EnvSource } from "../utils/env.ts";
import { runAsSundayBridge } from "./sunday-bridge-context.ts";
import { isSafeSundayNext, SUNDAY_DEFAULT_NEXT } from "./sunday-path.ts";
import {
  verifySundayToken,
  type SundayBridgeConfig,
  type SundayClaims,
} from "./sunday-token.ts";

// Sunday's sign-in handoff: POST /api/auth/sunday/enter takes a token Sunday
// signed (sunday-token.ts) and answers with an ordinary Better Auth session.
// Sunday's membership decides who gets in, so the sign-up rule stands aside
// for these accounts (sunday-bridge-context.ts), and a person is found by
// their Sunday id first, so a changed email on Sunday's side is not a new
// person. Every refusal gets one answer, so a caller learns nothing from it.

/** The provider id of the account row that ties a person to Sunday. */
export const SUNDAY_PROVIDER_ID = "sunday";

const REFUSED = {
  code: "SUNDAY_BRIDGE_REFUSED",
  message: "Open Signatures from Sunday again.",
};

// A first sign-in can lose two races in a row: the user insert to a second
// tab, then the link insert to it. The third lookup always finds the link.
const MAX_PROVISION_ATTEMPTS = 3;

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      typeof current === "object" &&
      "code" in current &&
      current.code === "23505"
    ) {
      return true;
    }

    current =
      typeof current === "object" && "cause" in current
        ? current.cause
        : undefined;
  }

  return false;
}

async function audit(
  input: Parameters<typeof recordSystemAuditEvent>[0],
): Promise<void> {
  try {
    await recordSystemAuditEvent(input);
  } catch (error) {
    console.error("[auth] Could not record a Sunday sign-in:", error);
  }
}

/** Burns the token's id; false when it was used before. */
async function claimTokenUse(claims: SundayClaims, nowSeconds: number) {
  const database = getDb();

  await database.query(
    "delete from public.sunday_bridge_uses where expires_at < $1",
    [nowSeconds],
  );

  const inserted = await database.query(
    "insert into public.sunday_bridge_uses (jti, expires_at) values ($1, $2) on conflict (jti) do nothing",
    [claims.jti, claims.exp],
  );

  return inserted.rowCount === 1;
}

export function sundayBridge(
  config: SundayBridgeConfig,
  options: { appUrl: string; env: EnvSource },
): BetterAuthPlugin {
  const audience = new URL(options.appUrl).origin;

  return {
    id: "sunday-bridge",
    endpoints: {
      sundayEnter: createAuthEndpoint(
        "/sunday/enter",
        {
          body: z.object({
            next: z.string().max(4096).optional(),
            token: z.string().max(4096),
          }),
          method: "POST",
        },
        async (ctx) => {
          const client = getRequestClient(
            ctx.request?.headers ?? ctx.headers,
            options.env,
          );
          const nowSeconds = Math.floor(Date.now() / 1000);
          const refuse = async (reason: string): Promise<never> => {
            await audit({
              actorEmail: null,
              actorUserId: null,
              event: "sign_in_failed",
              metadata: { method: "sunday", reason },
              targetUserId: null,
              ...client,
            });

            throw new APIError("UNAUTHORIZED", REFUSED);
          };

          const verified = verifySundayToken(ctx.body.token, {
            audience,
            nowSeconds,
            secret: config.secret,
            workspaceId: config.workspaceId,
          });

          if (!verified.ok) {
            return refuse(verified.reason);
          }

          const { claims } = verified;

          // Before any account work, so a replayed token changes nothing.
          if (!(await claimTokenUse(claims, nowSeconds))) {
            return refuse("replayed");
          }

          const internal = ctx.context.internalAdapter;

          const findUser = async (): Promise<User | null> => {
            const link = await internal.findAccountByKey({
              accountId: claims.sub,
              providerId: SUNDAY_PROVIDER_ID,
            });

            if (link) {
              return internal.findUserById(link.userId);
            }

            // Better Auth's own lookup matches the stored address exactly;
            // an account made before it lowercased addresses would be missed.
            const byEmail = await queryOne<{ id: string }>(
              getDb(),
              `select id from public."user" where lower(email) = $1 order by "createdAt" limit 1`,
              [claims.email],
            );

            if (!byEmail) {
              return null;
            }

            await internal.linkAccount({
              accountId: claims.sub,
              providerId: SUNDAY_PROVIDER_ID,
              userId: byEmail.id,
            });

            return internal.findUserById(byEmail.id);
          };

          const provision = async (): Promise<User> => {
            const found = await findUser();

            if (found) {
              return found;
            }

            // createUser drops role (this install declares no role field
            // to Better Auth), so an administrator is promoted after.
            const created = await internal.createUser(
              { email: claims.email, emailVerified: true, name: claims.name },
              { method: "sunday" },
            );

            await internal.linkAccount({
              accountId: claims.sub,
              providerId: SUNDAY_PROVIDER_ID,
              userId: created.id,
            });

            if (claims.role === "admin") {
              await getDb().query(
                `update public."user" set role = 'admin', "updatedAt" = now() where id = $1`,
                [created.id],
              );
            }

            return created;
          };

          let user: User | null = null;

          for (let attempt = 1; user === null; attempt += 1) {
            try {
              user = await runAsSundayBridge(provision);
            } catch (error) {
              // Another tab is signing the same person in for the first
              // time: what it made is found on the next lookup.
              if (
                !isUniqueViolation(error) ||
                attempt >= MAX_PROVISION_ATTEMPTS
              ) {
                throw error;
              }
            }
          }

          if (user.name !== claims.name) {
            user = await internal.updateUser(user.id, { name: claims.name });
          }

          const session = await internal.createSession(user.id);

          await setSessionCookie(ctx, { session, user });
          await audit({
            actorEmail: user.email,
            actorUserId: user.id,
            event: "sign_in_succeeded",
            metadata: { method: "sunday" },
            targetUserId: user.id,
            ...client,
          });

          return ctx.json({
            next: isSafeSundayNext(ctx.body.next)
              ? ctx.body.next
              : SUNDAY_DEFAULT_NEXT,
          });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
