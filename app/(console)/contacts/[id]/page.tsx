import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Avatar } from '@/components/avatar';
import { InfoTip } from '@/components/tooltip';
import { Badge, Card, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { DEFAULT_CONTACT_LOCALE } from '@/lib/contacts/locale';
import { conversationsForContact, getContact } from '@/lib/contacts/queries';
import {
  mergeCandidates,
  mergeHistory,
  resolveMergedContact,
  searchMergeCandidates,
} from '@/lib/contacts/merge';
import { shipmentsForContact, shippingAccountsForContact } from '@/lib/shipments/queries';
import { formatDateTime } from '@/lib/format';
import { LOCALE_NAMES, type Locale } from '@/lib/kb/locale';
import { ConversationTable } from '../conversation-table';
import { SyncBadge } from '../page';
import { AccountLinks, RoleToggles } from './forms';
import { MergeCandidateRow, MergeSearch } from './merge';

export const dynamic = 'force-dynamic';

/**
 * One contact.
 *
 * The page the console has never had. Its job here is to answer three questions
 * an agent could not previously ask: what else has this person written in about,
 * which shipping accounts can they speak for, and — since duplicates are the
 * normal state of a support database — is this person already in here twice.
 */
export default async function ContactPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const agent = await requirePermission('contact.view');
  const { id } = await params;

  const contact = await getContact(id);

  // A merged contact is a tombstone, so `getContact` (which filters deleted
  // rows) returns nothing for it. Follow the pointer instead of 404ing: the id
  // in the address bar is a bookmark, a quoted link or an imported reference,
  // and the person it names is still here under another id.
  if (!contact) {
    const survivor = await resolveMergedContact(id);
    if (survivor !== id) redirect(`/contacts/${survivor}`);
    notFound();
  }

  const search = await searchParams;
  const rawMerge = search.merge;
  const mergeQuery = (Array.isArray(rawMerge) ? rawMerge[0] : rawMerge)?.trim() ?? '';

  const mayMerge = can(agent, 'contact.merge');

  const [accounts, parcels, conversations, merges, duplicates] = await Promise.all([
    shippingAccountsForContact(contact.id),
    shipmentsForContact(contact.id),
    conversationsForContact(agent, contact.id),
    mergeHistory(contact.id),
    // Only for somebody who could act on the answer. The suggestion query is
    // three ILIKEs over the contact table and there is no reason to run it for
    // an agent who will only be shown a sentence saying they cannot merge.
    mayMerge
      ? mergeQuery
        ? searchMergeCandidates(contact.id, mergeQuery)
        : mergeCandidates(contact.id)
      : Promise.resolve([]),
  ]);

  const editable = can(agent, 'contact.edit');

  return (
    <div className="app-scroll h-full overflow-y-auto p-4 md:p-6">
      <PageHeader
        title={contact.name ?? contact.email ?? contact.phone ?? 'Unnamed contact'}
        description={[contact.email, contact.phone].filter(Boolean).join(' · ') || undefined}
        leading={
          <Avatar
            name={contact.name}
            contactId={contact.id}
            hasAvatar={contact.hasAvatar}
            size={40}
          />
        }
        actions={
          <Link href="/contacts" className="text-sm hover:underline">
            All contacts
          </Link>
        }
      />

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card>
          <h2 className="mb-2 text-sm font-medium">Roles</h2>
          {editable ? (
            <RoleToggles
              contactId={contact.id}
              isShipper={contact.isShipper}
              isRecipient={contact.isRecipient}
            />
          ) : (
            <div className="flex gap-1">
              {contact.isShipper ? <Badge tone="brand">Shipper</Badge> : null}
              {contact.isRecipient ? <Badge>Recipient</Badge> : null}
              {!contact.isShipper && !contact.isRecipient ? (
                <span className="text-xs opacity-50">Neither, so far.</span>
              ) : null}
            </div>
          )}
          <p className="mt-3 text-xs text-[var(--muted-foreground)]">
            Set automatically when we learn one — holding a shipping account makes someone a
            shipper, being named on a parcel makes them a recipient — and never unset automatically,
            so a designation made here survives the next sync.
          </p>
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-medium">Reachable on</h2>
          <ul className="flex flex-col gap-1 text-xs">
            {contact.identities.map((identity) => (
              <li key={identity.id} className="flex items-center gap-2">
                <span className="w-20 shrink-0 opacity-60">{identity.channel}</span>
                <span className="min-w-0 break-all">{identity.identifier}</span>
                {identity.isVerified ? <Badge tone="success">verified</Badge> : null}
                {/* What the channel itself reported, which can be more specific
                    than the language above — `en_GB` where we only store 'en'. */}
                {identity.profileLocale ? <Badge>{identity.profileLocale}</Badge> : null}
              </li>
            ))}
            {contact.identities.length === 0 ? <li className="opacity-50">None.</li> : null}
          </ul>
          {contact.companyName ? (
            <p className="mt-3 text-xs text-[var(--muted-foreground)]">
              Company: {contact.companyName}
            </p>
          ) : null}

          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <div className="flex gap-2">
              <dt className="opacity-60">Language</dt>
              <dd>
                {LOCALE_NAMES[contact.locale as Locale] ?? contact.locale}
                {/*
                  'en' is the column default, so it means "English" and "nobody
                  has told us" equally — and an agent about to write to somebody
                  deserves to know which. Anything else was learned.
                */}
                {contact.locale === DEFAULT_CONTACT_LOCALE ? (
                  <InfoTip label="this contact's language">
                    English is the default every contact starts at, so this reads the same whether
                    the customer told us or nobody ever asked. A profile lookup deliberately does
                    not change it &mdash; a Facebook interface language is not a support-language
                    preference, and this value decides what an auto-reply and a survey go out in on
                    every channel. What the channel itself reported is shown beside the identity
                    above.
                  </InfoTip>
                ) : null}
              </dd>
            </div>
            {contact.gender ? (
              <div className="flex gap-2">
                <dt className="opacity-60">Gender</dt>
                <dd>{contact.gender}</dd>
              </div>
            ) : null}
          </dl>
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-medium">Shipping accounts</h2>
          <AccountLinks contactId={contact.id} accounts={accounts} editable={editable} />
        </Card>
      </div>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-medium">Shipments</h2>
        {parcels.length === 0 ? (
          <Card>
            <p className="text-xs text-[var(--muted-foreground)]">
              This person is not named on any shipment yet. Nothing names them until a platform sync
              or an agent says which end of a parcel they are on.
            </p>
          </Card>
        ) : (
          <Card>
            <ul className="flex flex-col gap-2 text-sm">
              {parcels.map((parcel) => (
                <li key={parcel.id} className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/contacts/shipments/${encodeURIComponent(parcel.trackingNumber)}`}
                    className="font-medium hover:underline"
                  >
                    {parcel.trackingNumber}
                  </Link>
                  {parcel.isShipper ? <Badge tone="brand">shipper</Badge> : null}
                  {parcel.isRecipient ? <Badge>recipient</Badge> : null}
                  <SyncBadge state={parcel.syncState} />
                  <span className="text-xs opacity-60">{parcel.statusLabel ?? ''}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-medium">Conversations</h2>
        <ConversationTable
          conversations={conversations}
          emptyTitle="No conversations"
          emptyHint="Nothing this contact has written in about is visible to you."
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Duplicates</h2>
        <Card>
          {merges.length > 0 ? (
            <ul className="mb-4 flex flex-col gap-1 text-xs">
              {merges.map((merge) => (
                <li key={merge.id} className="flex flex-wrap items-baseline gap-x-2">
                  <Link
                    href={`/contacts/${merge.mergedContactId}`}
                    className="font-medium hover:underline"
                  >
                    {merge.name ?? merge.email ?? merge.phone ?? 'Unnamed contact'}
                  </Link>
                  <span className="text-[var(--muted-foreground)]">
                    merged in by {merge.agentName ?? 'a deleted agent'} on{' '}
                    {formatDateTime(merge.createdAt)} — {merge.moved.conversations} ticket
                    {merge.moved.conversations === 1 ? '' : 's'}, {merge.moved.identities} identit
                    {merge.moved.identities === 1 ? 'y' : 'ies'}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {!mayMerge ? (
            <p className="text-xs text-[var(--muted-foreground)]">
              {merges.length > 0
                ? 'Merging contacts needs the contact.merge permission.'
                : 'Nothing has been merged into this contact. Merging needs the contact.merge permission.'}
            </p>
          ) : (
            <>
              <p className="mb-3 text-xs text-[var(--muted-foreground)]">
                Folds another contact into this one: its tickets, addresses, numbers, account
                memberships and parcel roles move here, and it becomes a redirect to this page. This
                contact&rsquo;s own name, company and language are kept — a merge fills blanks and
                overwrites nothing. It is not reversible in one click, so read the counts.
              </p>

              <MergeSearch initial={mergeQuery} />

              <p className="mt-3 mb-1 text-xs font-medium">
                {mergeQuery ? `Matching “${mergeQuery}”` : 'Possible duplicates'}
              </p>

              {duplicates.length === 0 ? (
                <p className="text-xs text-[var(--muted-foreground)]">
                  {mergeQuery
                    ? 'No other contact matches that.'
                    : 'Nobody else shares this contact’s email, phone or name. Search above if you know of a duplicate.'}
                </p>
              ) : (
                <ul className="flex flex-col">
                  {duplicates.map((candidate) => (
                    <MergeCandidateRow
                      key={candidate.id}
                      survivorId={contact.id}
                      candidate={candidate}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </Card>
      </section>
    </div>
  );
}
