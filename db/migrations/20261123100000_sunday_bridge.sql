-- Sunday's sign-in handoff (src/lib/auth/sunday-bridge.ts).
--
-- sunday_bridge_uses: each accepted handoff token's id, kept until the
-- token expires, so a second use is refused by the primary key rather than
-- by timing. Expired rows are deleted when a new one is written.
--
-- idx_account_sunday_link: one Sunday person links to one account. Two
-- first sign-ins racing in two tabs end with one link row.

create table if not exists public.sunday_bridge_uses (
  jti text primary key,
  expires_at bigint not null
);

create index if not exists idx_sunday_bridge_uses_expires_at
  on public.sunday_bridge_uses (expires_at);

create unique index if not exists idx_account_sunday_link
  on public.account ("providerId", "accountId")
  where "providerId" = 'sunday';
