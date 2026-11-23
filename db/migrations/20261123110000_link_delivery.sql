-- Link delivery: the sender copies each signer's signing link from the
-- envelope page and delivers it themselves (src/lib/signing-link-copy.ts).
--
-- envelopes.delivery 'link': no invitations or reminders are emailed. The
-- link is an ordinary /sign/ link that lasts like an emailed one. The
-- check made inline by 20261118120000_embedded_signing.sql has the name
-- Postgres gave it, so it is looked up rather than assumed.
--
-- signers.link_nonce: the random value the copied link is derived from
-- with a key made from BETTER_AUTH_SECRET. Copying again gives the same
-- link while its hash is still the signer's live one; the database alone
-- never holds a working link.
--
-- audit_events: 'link_copied' and 'link_replaced', the sender copying a
-- signer's link and replacing it with a new one.
--
-- A copy of the app from before this migration treats a 'link' envelope as
-- neither emailed nor embedded. Roll back past this migration only with no
-- link envelopes out for signature.

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.envelopes'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%delivery%'
  loop
    execute format(
      'alter table public.envelopes drop constraint %I',
      constraint_name
    );
  end loop;
end
$$;

alter table public.envelopes
  add constraint envelopes_delivery_check
    check (delivery in ('email', 'embedded', 'link'));

alter table public.signers
  add column if not exists link_nonce text;

alter table public.audit_events
  drop constraint if exists audit_events_event_check;

alter table public.audit_events
  add constraint audit_events_event_check
    check (event in (
      'created',
      'sent',
      'viewed',
      'consented',
      'verified',
      'verification_failed',
      'signed',
      'declined',
      'reminded_manual',
      'email_sent',
      'completed',
      'voided',
      'deadline_changed',
      'expired',
      'reminded_auto',
      'reauthentication_failed',
      'copied',
      'signer_corrected',
      'approved',
      'rejected',
      'link_copied',
      'link_replaced'
    ));
