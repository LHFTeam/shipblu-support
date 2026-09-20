import Link from 'next/link';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, groups, whatsappAccounts, whatsappTemplates } from '@/db/schema';
import { ChannelBadge } from '@/components/channel';
import { Badge, Card, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { env } from '@/lib/env';
import { listFolderOptions } from '@/lib/kb/admin';
import { offerableFaqFolders, parseWidgetConfig } from '@/lib/widget/config';
import { ChannelForm, InAppChatSettings } from './forms';
import { NewWhatsAppAccount, WhatsAppAccountEditor, type WhatsAppAccountRow } from './waba-forms';

export const dynamic = 'force-dynamic';

export default async function ChannelsPage() {
  await requirePermission('admin.channels');

  const [channelList, groupList, accountList, templateCounts, folderList] = await Promise.all([
    db
      .select({
        id: channels.id,
        type: channels.type,
        name: channels.name,
        config: channels.config,
        createdAt: channels.createdAt,
        defaultGroupId: channels.defaultGroupId,
        whatsappAccountId: channels.whatsappAccountId,
        isActive: channels.isActive,
      })
      .from(channels)
      .orderBy(asc(channels.name)),

    db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(asc(groups.name)),

    db.select().from(whatsappAccounts).orderBy(asc(whatsappAccounts.name)),

    db
      .select({
        accountId: whatsappTemplates.whatsappAccountId,
        total: sql<number>`count(*)::int`,
      })
      .from(whatsappTemplates)
      .where(eq(whatsappTemplates.status, 'APPROVED'))
      .groupBy(whatsappTemplates.whatsappAccountId),

    listFolderOptions(),
  ]);

  // The same rule `saveChannel` validates against, so the picker cannot offer a
  // folder the action would refuse.
  const faqFolders = offerableFaqFolders(folderList).map(
    ({ id, name, categoryName, categoryLocale }) => ({
      id,
      name,
      categoryName,
      categoryLocale,
    }),
  );

  // The same rows `webchatChannel()` and `mobileChannel()` read — oldest active
  // first, per type. Picking by a different rule would let an admin configure
  // one row while the surface read another, and the setting would look saved
  // and do nothing.
  const inAppChannels = (['webchat', 'mobile'] as const)
    .map(
      (type) =>
        channelList
          .filter((channel) => channel.type === type && channel.isActive)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0],
    )
    .filter((channel): channel is (typeof channelList)[number] => Boolean(channel));

  const accountChoices = accountList.map((account) => ({ id: account.id, name: account.name }));
  const templatesByAccount = new Map(templateCounts.map((row) => [row.accountId, row.total]));

  const accounts: WhatsAppAccountRow[] = accountList.map((account) => ({
    ...account,
    numbers: channelList
      .filter((channel) => channel.whatsappAccountId === account.id)
      .map((channel) => channel.name),
    templateCount: templatesByAccount.get(account.id) ?? 0,
  }));

  // The WABA the environment already names, offered as a starting value when no
  // row uses it yet. The hourly template sync adopts it on its own, and this is
  // the same thing an hour sooner — the alternative is an admin retyping an id
  // the system is already configured with, or worse, guessing at a new one.
  const configuredWabaId = env().WHATSAPP_WABA_ID ?? null;
  const unadopted =
    configuredWabaId && !accountList.some((account) => account.wabaId === configuredWabaId)
      ? configuredWabaId
      : null;

  return (
    <div className="flex flex-col gap-8">
      <section>
        <PageHeader
          title="WhatsApp business accounts"
          description="One connection per WABA. Numbers, templates and media are all scoped to a business account by Meta, so which one a number belongs to decides which credential it sends with and which templates an agent may pick."
          actions={
            <NewWhatsAppAccount suggestedWabaId={unadopted} isFirst={accountList.length === 0} />
          }
        />

        {/* Said once, here, because it is the limit people hit second: adding a
            WABA from a different Meta app looks like it works — the row saves —
            and then every inbound message from it is answered 403 by the webhook
            and stored unverified, which reads as a forgery rather than as a
            second app secret nobody can configure. */}
        <p className="mb-3 text-xs text-[var(--muted-foreground)]">
          Every account here must sit under the same Meta app: one app secret verifies every inbound
          webhook and one verify token answers every handshake. A separate token per account is fine
          — an account that needs one names the variable holding it.
        </p>

        <div className="flex flex-col gap-2">
          {accounts.map((account) => (
            <Card key={account.id}>
              <WhatsAppAccountEditor account={account} />
            </Card>
          ))}
        </div>

        {accounts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--border)] px-3 py-6 text-center text-xs text-[var(--muted-foreground)]">
            {unadopted
              ? `None connected yet. WHATSAPP_WABA_ID names ${unadopted}; connect it above, or leave it and the hourly template sync will.`
              : 'None connected. WhatsApp numbers fall back to META_PAGE_ACCESS_TOKEN and WHATSAPP_WABA_ID from the environment.'}
          </p>
        ) : null}
      </section>

      <section>
        <PageHeader
          title="Channels"
          description="Addresses and routing only. Access tokens and webhook secrets are hardcoded and live as server environment variables, so a database dump never contains a usable credential."
        />

        <ul className="mb-4 divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface)] text-sm">
          {channelList.length === 0 ? (
            <li className="px-3 py-2.5 text-[var(--muted-foreground)]">
              No channels configured yet. Tickets still arrive; they just have no default group.
            </li>
          ) : null}
          {channelList.map((channel) => {
            const account = accounts.find((row) => row.id === channel.whatsappAccountId);
            const isWhatsApp = channel.type === 'whatsapp' || channel.type === 'whatsapp_bot';

            return (
              <li key={channel.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <ChannelBadge channel={channel.type} />
                <span className="font-medium">{channel.name}</span>
                {!channel.isActive ? <Badge tone="neutral">inactive</Badge> : null}
                {/* A number with no account sends with the default one's
                    credential. Fine while there is exactly one account, and a
                    real hazard once there are two — so it is only called out
                    when there is something to be wrong about. */}
                {isWhatsApp && !account && accounts.length > 1 ? (
                  <Badge tone="warning">no business account</Badge>
                ) : null}
                <span className="ms-auto text-xs text-[var(--muted-foreground)]">
                  {isWhatsApp
                    ? `${(channel.config.phoneNumberId as string) || 'no phone number id'}${
                        account ? ` · ${account.name}` : ''
                      }`
                    : channel.type === 'facebook' || channel.type === 'instagram'
                      ? 'hardcoded in server environment variables'
                      : channel.type === 'webchat'
                        ? 'the widget'
                        : channel.type === 'mobile'
                          ? 'the myBlu app'
                          : // Only the channels that genuinely have an address
                            // fall through to this. Letting an in-app channel
                            // land here is the catch-all mistake `saveChannel`
                            // records production still carrying, printed at the
                            // admin instead of stored.
                            (channel.config.address as string) || 'no address'}
                </span>
              </li>
            );
          })}
        </ul>

        {/* Above the "add a channel" form because it is a setting on a row that
            already exists, not another row to create — and because the widget is
            the one channel whose configuration a customer sees directly. */}
        {inAppChannels.map((channel) => (
          <Card key={channel.id} className="mb-4">
            <InAppChatSettings
              channel={{
                id: channel.id,
                name: channel.name,
                type: channel.type as 'webchat' | 'mobile',
                defaultGroupId: channel.defaultGroupId,
                faqFolders: parseWidgetConfig(channel.config).faqFolders,
              }}
              groups={groupList}
              folders={faqFolders}
            />
          </Card>
        ))}

        <ChannelForm groups={groupList} whatsappAccounts={accountChoices} />
      </section>

      {/* The groups that the default-group picker above chooses between, listed
          so that "which group?" can be answered without leaving the page.
          Creating and editing them is the Groups page's job — a group there
          also carries a description and its own business hours, and a second
          form that could only set the name would quietly make half a group. */}
      <section>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-lg font-semibold">Groups</h2>
          <Link href="/admin/groups" className="ms-auto text-sm text-brand-600 hover:underline">
            Manage groups
          </Link>
        </div>
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] text-sm">
          {groupList.length === 0 ? (
            <li className="px-3 py-2.5 opacity-50">No groups yet.</li>
          ) : null}
          {groupList.map((group) => (
            <li key={group.id} className="px-3 py-2.5">
              {group.name}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
