import Link from 'next/link';
import { ChannelBadge } from '@/components/channel';
import { Badge, Card, PageHeader } from '@/components/ui';
import {
  countTemplatesByAccount,
  listChannelsForAdmin,
  listGroupNames,
  listWhatsAppAccounts,
} from '@/lib/admin/settings';
import { requirePermission } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { env } from '@/lib/env';
import { listFolderOptions } from '@/lib/kb/admin';
import {
  canRequestSync,
  needsReconnect,
  parseCoexistence,
  SYNC_TYPES,
} from '@/lib/whatsapp/coexistence';
import { credentialStatuses } from '@/lib/whatsapp/credentials';
import { coexistenceReadiness } from '@/lib/whatsapp/onboarding';
import { listLatestOnboardings } from '@/lib/whatsapp/onboarding-reads';
import { shownOnboardings } from '@/lib/whatsapp/onboarding-view';
import { offerableFaqFolders, parseWidgetConfig } from '@/lib/widget/config';
import {
  CoexistenceBadges,
  ConnectBusinessAppNumber,
  OnboardingProgress,
  RequestSyncAgain,
} from './coexistence-forms';
import { ChannelEditor, ChannelForm, WebchatSettings } from './forms';
import { NewWhatsAppAccount, WhatsAppAccountEditor, type WhatsAppAccountRow } from './waba-forms';

export const dynamic = 'force-dynamic';

export default async function ChannelsPage() {
  const agent = await requirePermission('admin.channels');
  // Connecting a number stores a credential and imports a business's chats,
  // which is a separate thing to hand out from renaming a channel; the page
  // offers the button, the copy buttons and "forget" only to those who have it.
  const canConnect = can(agent, 'admin.channels.connect');

  const [
    channelList,
    groupList,
    accountList,
    templateCounts,
    folderList,
    credentials,
    onboardings,
  ] = await Promise.all([
    listChannelsForAdmin(),
    listGroupNames(),
    listWhatsAppAccounts(),
    countTemplatesByAccount(),
    listFolderOptions(),
    credentialStatuses(),
    listLatestOnboardings(),
  ]);

  // Read on the server, where the variables are. Not ready is still a page:
  // the card names what is missing and where to set it.
  const readiness = coexistenceReadiness();
  // One clock for every sentence on the page, so the badge on a row and the
  // card above it cannot disagree about whether a window has closed.
  const now = new Date();

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

  // The same row `webchatChannel()` reads — oldest active first. Picking by a
  // different rule would let an admin configure one row while the widget read
  // another, and the setting would look saved and do nothing.
  const webchat = channelList
    .filter((channel) => channel.type === 'webchat' && channel.isActive)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];

  const accountChoices = accountList.map((account) => ({ id: account.id, name: account.name }));
  const templatesByAccount = new Map(templateCounts.map((row) => [row.accountId, row]));

  const accounts: WhatsAppAccountRow[] = accountList.map((account) => ({
    ...account,
    numbers: channelList
      .filter((channel) => channel.whatsappAccountId === account.id)
      .map((channel) => channel.name),
    templateCount: templatesByAccount.get(account.id)?.approved ?? 0,
    templateTotal: templatesByAccount.get(account.id)?.total ?? 0,
    credential: credentials.get(account.id) ?? null,
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

  // The group a new number most likely wants: the one the existing WhatsApp
  // number routes to, when there is exactly one to copy. Two numbers in two
  // groups is a question the card asks rather than guesses.
  const whatsappChannels = channelList.filter((channel) => channel.type === 'whatsapp');
  const suggestedGroupId =
    whatsappChannels.length === 1 ? (whatsappChannels[0]?.defaultGroupId ?? null) : null;

  const connectProps = { readiness, groups: groupList, suggestedGroupId };

  // The latest attempt per number, while there is something to watch: running,
  // connected within the day, or failed within the week — except a number Meta
  // did not list on the business account, once a later attempt on that account
  // has connected: the wrong number picked and then the right one
  // (`shownOnboardings`). A card per number rather than per attempt, so a retry
  // replaces its predecessor instead of stacking under it.
  const progressCards = shownOnboardings(onboardings, now);

  return (
    <div className="flex flex-col gap-8">
      <section>
        <PageHeader
          title="WhatsApp business accounts"
          description="One connection per WABA. Numbers, templates and media are all scoped to a business account by Meta, so which one a number belongs to decides which credential it sends with and which templates an agent may pick."
          actions={
            <>
              {canConnect ? <ConnectBusinessAppNumber {...connectProps} mode="connect" /> : null}
              <NewWhatsAppAccount suggestedWabaId={unadopted} isFirst={accountList.length === 0} />
            </>
          }
        />

        {/* Said once, here, because it is the limit people hit second: adding a
            WABA from a different Meta app looks like it works — the row saves —
            and then every inbound message from it is answered 403 by the webhook
            and stored unverified, which reads as a forgery rather than as a
            second app secret nobody can configure. */}
        <p className="mb-3 text-xs text-[var(--muted-foreground)]">
          Every account here must sit under the same Meta app: one app secret verifies every inbound
          webhook and one verify token answers every handshake. A number connected through
          Meta&rsquo;s window is under this app by construction — the window is opened as it, and
          the credential it mints is stored sealed. An account added by its ids sends with the
          shared token, or with a variable it names.
        </p>

        <div className="flex flex-col gap-2">
          {accounts.map((account) => (
            <Card key={account.id}>
              <WhatsAppAccountEditor
                account={account}
                connect={connectProps}
                canConnect={canConnect}
                now={now}
              />
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
          description="Addresses and routing only. Credentials live in the environment — or, for a number connected through Meta, sealed in the database under a key the database never sees — so a dump never contains a usable token."
        />

        {progressCards.length > 0 ? (
          <div className="mb-4 flex flex-col gap-2">
            {progressCards.map((onboarding) => {
              const channel = onboarding.channelId
                ? channelList.find((row) => row.id === onboarding.channelId)
                : undefined;
              const account = accountList.find((row) => row.wabaId === onboarding.wabaId);
              return (
                <OnboardingProgress
                  key={onboarding.id}
                  onboarding={onboarding}
                  coexistence={channel ? parseCoexistence(channel.config) : null}
                  channelName={channel?.name ?? null}
                  accountName={account?.name ?? null}
                  credential={account ? (credentials.get(account.id) ?? null) : null}
                  canConnect={canConnect}
                  // A failed attempt's new sign-in: an attempt that reached a
                  // channel suggests that channel's group, as the row's own
                  // reconnect does.
                  connect={
                    channel
                      ? { ...connectProps, suggestedGroupId: channel.defaultGroupId }
                      : connectProps
                  }
                  now={now}
                />
              );
            })}
          </div>
        ) : null}

        <ul className="mb-4 divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface)] text-sm">
          {channelList.length === 0 ? (
            <li className="px-3 py-2.5 text-[var(--muted-foreground)]">
              No channels configured yet. Tickets still arrive; they just have no default group.
            </li>
          ) : null}
          {channelList.map((channel) => {
            const account = accounts.find((row) => row.id === channel.whatsappAccountId);
            const isWhatsApp = channel.type === 'whatsapp' || channel.type === 'whatsapp_bot';
            const coexistence =
              channel.type === 'whatsapp' ? parseCoexistence(channel.config) : null;

            // A number that was disconnected on the phone, whose copy window
            // closed with a copy never made, whose history the phone declined,
            // or whose history copy stalled part-way, is reconnected through
            // the same window it was connected through — `needsReconnect`,
            // drawn from the same facts as the badge that says which.
            const reconnectable = coexistence !== null && needsReconnect(coexistence, now);
            // The copy buttons wait for the attempt that wrote this object to
            // finish connecting: until then the copy is one of its own steps,
            // shown on its progress card, and the job would skip a run of the
            // copy alone. Keyed on the attempt the channel names, not on the
            // latest per number — a newer attempt that failed early leaves
            // this one connected and its buttons working. The action asks
            // again, since this render can be stale.
            const attempt = coexistence?.onboardingId
              ? onboardings.find((onboarding) => onboarding.id === coexistence.onboardingId)
              : undefined;
            const stillConnecting = attempt?.status === 'exchanged';

            return (
              <li key={channel.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <ChannelBadge channel={channel.type} />
                <span className="font-medium">{channel.name}</span>
                {!channel.isActive ? <Badge tone="neutral">inactive</Badge> : null}
                {coexistence ? <CoexistenceBadges config={channel.config} now={now} /> : null}
                {/* A number with no account sends with the default one's
                    credential. Fine while there is exactly one account, and a
                    real hazard once there are two — so it is only called out
                    when there is something to be wrong about. Edit, beside it,
                    is what clears it: the badge used to name a problem the
                    console had no way to fix. */}
                {isWhatsApp && !account && accounts.length > 1 ? (
                  <Badge tone="warning">no business account</Badge>
                ) : null}
                <span className="ms-auto text-xs text-[var(--muted-foreground)]">
                  {coexistence
                    ? `${coexistence.displayPhoneNumber ?? (channel.config.phoneNumberId as string)}${
                        coexistence.verifiedName ? ` · ${coexistence.verifiedName}` : ''
                      }${account ? ` · ${account.name}` : ''}`
                    : isWhatsApp
                      ? `${(channel.config.phoneNumberId as string) || 'no phone number id'}${
                          account ? ` · ${account.name}` : ''
                        }`
                      : channel.type === 'facebook' || channel.type === 'instagram'
                        ? 'hardcoded in server environment variables'
                        : channel.type === 'webchat'
                          ? 'the widget'
                          : (channel.config.address as string) || 'no address'}
                </span>
                {coexistence && canConnect && channel.isActive && !stillConnecting
                  ? SYNC_TYPES.map((type) => {
                      if (!canRequestSync(coexistence, type, now).ok) return null;
                      const slot = coexistence.syncs[type];
                      return (
                        <RequestSyncAgain
                          key={type}
                          channelId={channel.id}
                          type={type}
                          again={Boolean(slot && 'error' in slot)}
                        />
                      );
                    })
                  : null}
                <ChannelEditor
                  channel={channel}
                  groups={groupList}
                  whatsappAccounts={accountChoices}
                />
                {reconnectable && canConnect ? (
                  <ConnectBusinessAppNumber
                    {...connectProps}
                    suggestedGroupId={channel.defaultGroupId}
                    mode="reconnect"
                  />
                ) : null}
              </li>
            );
          })}
        </ul>

        {/* Above the "add a channel" form because it is a setting on a row that
            already exists, not another row to create — and because the widget is
            the one channel whose configuration a customer sees directly. */}
        {webchat ? (
          <Card className="mb-4">
            <WebchatSettings
              channel={{
                id: webchat.id,
                name: webchat.name,
                defaultGroupId: webchat.defaultGroupId,
                faqFolders: parseWidgetConfig(webchat.config).faqFolders,
              }}
              groups={groupList}
              folders={faqFolders}
            />
          </Card>
        ) : null}

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
