import Link from 'next/link';
import { ChannelBadge } from '@/components/channel';
import { Badge, Card, PageHeader } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import {
  countTemplatesByAccount,
  listAccountsForAdmin,
  listActiveAgents,
  listChannelsForAdmin,
  listGroupNames,
} from '@/lib/admin/settings';
import { requirePermission } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { allLimited } from '@/lib/concurrency';
import { env } from '@/lib/env';
import { formatDateTime } from '@/lib/format';
import { listFolderOptions } from '@/lib/kb/admin';
import { routingReadiness } from '@/lib/routing/readiness';
import { isMetaChannel } from '@/lib/tickets/channel-policy';
import {
  canRequestSync,
  needsReconnect,
  parseCoexistence,
  SYNC_TYPES,
} from '@/lib/whatsapp/coexistence';
import { credentialStatuses } from '@/lib/whatsapp/credentials';
import { numberOwnership, type NumberOwnership } from '@/lib/whatsapp/number-owner';
import { coexistenceReadiness } from '@/lib/whatsapp/onboarding';
import { listLatestOnboardings } from '@/lib/whatsapp/onboarding-reads';
import {
  pagePollIntervalMs,
  progressVersion,
  shownOnboardings,
} from '@/lib/whatsapp/onboarding-view';
import { offerableFaqFolders, parseWidgetConfig } from '@/lib/widget/config';
import { webchatSwitch, widgetRow } from '@/lib/widget/rows';
import {
  CoexistenceBadges,
  ConnectBusinessAppNumber,
  OnboardingPolling,
  OnboardingProgress,
  RequestSyncAgain,
} from './coexistence-forms';
import {
  ChannelEditor,
  ChannelForm,
  OwnerEditor,
  WebchatActiveSwitch,
  WebchatSettings,
  type OwnerChoice,
  type WebchatSwitchView,
} from './forms';
import { RoutingBadge, RoutingReadinessPanel } from './routing-readiness';
import { NewWhatsAppAccount, WhatsAppAccountEditor, type WhatsAppAccountRow } from './waba-forms';

export const dynamic = 'force-dynamic';

export default async function ChannelsPage() {
  const agent = await requirePermission('admin.channels');
  // Connecting a number stores a credential and imports a business's chats,
  // which is a separate thing to hand out from renaming a channel; the page
  // offers the button, the copy buttons and "forget" only to those who have it.
  const canConnect = can(agent, 'admin.channels.connect');

  // One clock for every sentence on the page, so the badge on a row and the
  // card above it cannot disagree about whether a window has closed — nor the
  // routing panel about who is accepting tickets.
  const now = new Date();

  // Three at a time rather than all ten at once. The layouts' own reads run
  // beside these, and ten together would take every one of the gate's eight
  // places from every other request for the length of a render. On 2026-10-11,
  // before the gate, the onboarding's click set off two of these renders at
  // once on a pool of ten that had already lost connections, and that is where
  // the freeze's last stretch began (§6.91). The routing panel's reads are one
  // lane of the three, a query at a time.
  const [
    channelList,
    groupList,
    accountList,
    templateCounts,
    folderList,
    credentials,
    onboardings,
    agentList,
    ownershipList,
    routing,
  ] = await allLimited(3, [
    () => listChannelsForAdmin(),
    () => listGroupNames(),
    () => listAccountsForAdmin(),
    () => countTemplatesByAccount(),
    () => listFolderOptions(),
    () => credentialStatuses(),
    () => listLatestOnboardings(),
    () => listActiveAgents(),
    () => numberOwnership(),
    () => routingReadiness(now),
  ]);

  // Read on the server, where the variables are. Not ready is still a page:
  // the card names what is missing and where to set it.
  const readiness = coexistenceReadiness();

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

  // The same row `webchatChannel()` reads: oldest active first, ties by id,
  // which is the order `routingReadiness` read every row in. Picking by a
  // different rule would let an admin configure one row while the widget read
  // another, and the setting would look saved and do nothing — sorting this
  // page's own list, ordered by name and timed to the millisecond, was one.
  // Only the order is taken from that read, which no write moves; the rows
  // themselves are the list's, so the Inactive badge, the switch and the card
  // are drawn from one read of each row, and a switch committed between the
  // two reads cannot set them against each other. A row the routing read
  // missed was added after it, so it is the newest and goes last. Each web
  // chat row's switch is worded from these rows, by the rule the action
  // applies again under its lock.
  const order = new Map(routing.channels.map((channel, index) => [channel.id, index]));
  const position = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  const webchatRows = channelList
    .filter((channel) => channel.type === 'webchat')
    .sort((a, b) => position(a.id) - position(b.id));
  const webchat = widgetRow(webchatRows);
  const switchView = (channelId: string): WebchatSwitchView | null => {
    const plan = webchatSwitch(webchatRows, channelId);
    if (plan?.kind !== 'switch_off') return plan;
    return { kind: 'switch_off', widgetMovesTo: plan.widgetMovesTo?.name ?? null };
  };

  const accountChoices = accountList.map((account) => ({ id: account.id, name: account.name }));
  const ownerChoices: OwnerChoice[] = agentList.map(({ id, name, email }) => ({ id, name, email }));
  const ownershipById = new Map(ownershipList.map((row) => [row.channelId, row]));
  const templatesByAccount = new Map(templateCounts.map((row) => [row.accountId, row]));
  // Each row's saved routing mode, which the three forms that save a channel
  // open on, and what the router makes of it.
  const routingById = new Map(routing.channels.map((row) => [row.id, row]));
  const savedRoutingMode = (channelId: string) =>
    routingById.get(channelId)?.column ?? 'default_group';
  const classifierMode = routing.classifier.mode;

  // Spread whole into a client component's props, and so into the RSC payload:
  // safe only because `listAccountsForAdmin` names its columns. A column it
  // does not name never reaches the browser, whatever the table grows next.
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

  // What the page asks `/api/admin/onboarding-progress` about while anything
  // shown is moving, and how often. It renders again only when the answer
  // differs from this one. The rows go in as the readers returned them: the
  // endpoint calls the same four readers and hands them over the same way, so
  // what counts as a change is decided in one place (`progressVersion`).
  const progressVersionNow = progressVersion(
    { onboardings, channels: channelList, accounts: accountList, credentials },
    now,
  );
  const pollMs = pagePollIntervalMs(
    progressCards,
    (onboarding) => {
      const channel = onboarding.channelId
        ? channelList.find((row) => row.id === onboarding.channelId)
        : undefined;
      return channel ? parseCoexistence(channel.config) : null;
    },
    now,
  );

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
        <p className="mb-3 text-xs text-(--color-text-secondary)">
          Every account here must sit under the same Meta app: one app secret verifies every inbound
          webhook and one verify token answers every handshake. A number connected through
          Meta&rsquo;s window is under this app by construction — the window is opened as it, and
          the credential it mints is stored sealed. An account added by its ids sends with the
          shared token, or with a variable it names — and a Business-app number connected in
          WhatsApp Manager or Business Suite instead is added from its account&rsquo;s row, where it
          sends with that account&rsquo;s credential or variable, never the shared token.
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
          <p className="rounded-xl border border-dashed border-(--color-border-default) px-4 py-6 text-center text-xs text-(--color-text-secondary)">
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

        <OnboardingPolling intervalMs={pollMs} version={progressVersionNow} />
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
                  tokenEnvVar={account?.tokenEnvVar ?? null}
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

        <ul className="mb-4 divide-y divide-(--color-border-subtle) rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) text-sm">
          {channelList.length === 0 ? (
            <li className="px-4 py-3 text-(--color-text-secondary)">
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
            // Every WhatsApp number, plain or coexistence, and nothing else: the bot and the
            // shared inboxes are the whole team's, and the database refuses an
            // owner on them (`channels_owner_only_whatsapp`).
            const ownership =
              channel.type === 'whatsapp' ? ownershipById.get(channel.id) : undefined;
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
            const switchPlan = channel.type === 'webchat' ? switchView(channel.id) : null;

            return (
              <li key={channel.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <ChannelBadge channel={channel.type} />
                <span className="font-medium">{channel.name}</span>
                {!channel.isActive ? <Badge tone="neutral">Inactive</Badge> : null}
                {coexistence ? <CoexistenceBadges config={channel.config} now={now} /> : null}
                <RoutingBadge channel={routingById.get(channel.id)} />
                {/* A number with no account sends with the default one's
                    credential. Fine while there is exactly one account, and a
                    real hazard once there are two — so it is only called out
                    when there is something to be wrong about. Edit, beside it,
                    is what clears it: the badge used to name a problem the
                    console had no way to fix. */}
                {isWhatsApp && !account && accounts.length > 1 ? (
                  <Badge tone="warning">No business account</Badge>
                ) : null}
                <span className="ms-auto text-xs text-(--color-text-secondary)">
                  {coexistence
                    ? `${coexistence.displayPhoneNumber ?? (channel.config.phoneNumberId as string)}${
                        coexistence.verifiedName ? ` · ${coexistence.verifiedName}` : ''
                      }${account ? ` · ${account.name}` : ''}`
                    : isWhatsApp
                      ? `${(channel.config.phoneNumberId as string) || 'no phone number id'}${
                          account ? ` · ${account.name}` : ''
                        }`
                      : isMetaChannel(channel.type)
                        ? 'hardcoded in server environment variables'
                        : channel.type === 'webchat'
                          ? channel.id === webchat?.id
                            ? 'the widget'
                            : 'not the widget’s row'
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
                          version={progressVersionNow}
                        />
                      );
                    })
                  : null}
                {/* The widget's row is edited by the Chat widget card below,
                    which has its folders: two forms saving one row's group and
                    mode would each put the other's stale values back. */}
                {channel.type === 'webchat' && channel.id === webchat?.id ? (
                  <span className="text-xs text-(--color-text-secondary)">
                    Edited under Chat widget
                  </span>
                ) : (
                  <ChannelEditor
                    channel={{ ...channel, routingMode: savedRoutingMode(channel.id) }}
                    groups={groupList}
                    whatsappAccounts={accountChoices}
                    classifierMode={classifierMode}
                  />
                )}
                {switchPlan ? (
                  <WebchatActiveSwitch
                    channelId={channel.id}
                    plan={switchPlan}
                    widgetId={webchat?.id ?? null}
                  />
                ) : null}
                {reconnectable && canConnect ? (
                  <ConnectBusinessAppNumber
                    {...connectProps}
                    suggestedGroupId={channel.defaultGroupId}
                    mode="reconnect"
                  />
                ) : null}
                {ownership ? <NumberOwnerLine ownership={ownership} agents={ownerChoices} /> : null}
              </li>
            );
          })}
        </ul>

        {/* Above the "add a channel" form because it is a setting on a row that
            already exists, not another row to create — and because the widget is
            the one channel whose configuration a customer sees directly. */}
        {webchat ? (
          <Card className="mb-4">
            {/* Keyed on the row, because a switch can hand the widget to
                another one while the card is open: reused, its hidden id
                followed the new row while its selects kept the old row's
                group, mode and folders, and saving wrote those over the new
                row's own. */}
            <WebchatSettings
              key={webchat.id}
              channel={{
                id: webchat.id,
                name: webchat.name,
                defaultGroupId: webchat.defaultGroupId,
                faqFolders: parseWidgetConfig(webchat.config).faqFolders,
                routingMode: savedRoutingMode(webchat.id),
              }}
              groups={groupList}
              folders={faqFolders}
              classifierMode={classifierMode}
            />
          </Card>
        ) : null}

        <ChannelForm
          groups={groupList}
          whatsappAccounts={accountChoices}
          classifierMode={classifierMode}
        />
      </section>

      <RoutingReadinessPanel
        readiness={routing}
        canEditCategories={can(agent, 'admin.categories')}
        canViewReport={can(agent, 'report.view')}
      />

      {/* The groups that the default-group picker above chooses between, listed
          so that "which group?" can be answered without leaving the page.
          Creating and editing them is the Groups page's job — a group there
          also carries a description and its own business hours, and a second
          form that could only set the name would quietly make half a group. */}
      <section>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-lg font-semibold">Groups</h2>
          <Link
            href="/admin/groups"
            className="ms-auto text-sm text-(--color-text-link) hover:text-(--color-text-link-hover) hover:underline"
          >
            Manage groups
          </Link>
        </div>
        <ul className="divide-y divide-(--color-border-subtle) rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) text-sm">
          {groupList.length === 0 ? (
            <li className="px-4 py-3 text-(--color-text-tertiary)">No groups yet.</li>
          ) : null}
          {groupList.map((group) => (
            <li key={group.id} className="px-4 py-3">
              {group.name}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * Who answers for a WhatsApp number, on a line of its own under the row: the
 * owner or "Team number", a warning when the owner can no longer sign in,
 * since when and set by whom, the owners before, and the control that hands it
 * over.
 *
 * Drawn from `numberOwnership()` alone, so the badge, the "since" and the
 * count the handover form states cannot come from two reads that disagree. A
 * deactivated owner keeps the badge, beside the warning: the number is still
 * theirs, and reactivating them is one of the two ways out — the policy is that
 * their existing tickets stay with them while new ones go to the group's rota.
 */
function NumberOwnerLine({
  ownership,
  agents,
}: {
  ownership: NumberOwnership;
  agents: OwnerChoice[];
}) {
  const { owner, current, earlier } = ownership;

  return (
    <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-xs text-(--color-text-secondary)">
      {owner ? (
        <Badge tone="info">
          Owner: <span dir="auto">{owner.label}</span>
          <InfoTip label="Owner">
            New tickets on this number are assigned to its owner, and every ticket on it counts
            against them for its SLA, whoever it is reassigned to. Unassigning one hands it back to
            them.
          </InfoTip>
        </Badge>
      ) : (
        <Badge tone="neutral">
          Team number
          <InfoTip label="Team number">
            Nobody owns this number. Its default group&rsquo;s rota assigns new tickets, and each
            ticket counts against whoever holds it.
          </InfoTip>
        </Badge>
      )}
      {owner && !owner.active ? (
        <Badge tone="warning">
          Owner deactivated
          <InfoTip label="Owner deactivated">
            The owner can no longer sign in. Until the number is handed to somebody else, or they
            are reactivated, its new tickets go to the default group&rsquo;s rota and count against
            whoever holds them; the tickets it already has stay with them.
          </InfoTip>
        </Badge>
      ) : null}
      {current ? (
        <span>
          since {formatDateTime(current.createdAt)}
          {current.changedByLabel ? (
            <>
              , set by <span dir="auto">{current.changedByLabel}</span>
            </>
          ) : null}
        </span>
      ) : null}
      {earlier.length > 0 ? (
        <details>
          <summary className="cursor-pointer">
            Earlier {earlier.length === 1 ? 'owner' : 'owners'} ({earlier.length})
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {earlier.map((change) => (
              <li key={change.id}>
                <span dir="auto">{change.toLabel ?? 'Team number'}</span> from{' '}
                {formatDateTime(change.createdAt)}
                {change.changedByLabel ? (
                  <>
                    , set by <span dir="auto">{change.changedByLabel}</span>
                  </>
                ) : null}
                {change.ticketsMoved > 0
                  ? ` · ${change.ticketsMoved} ${change.ticketsMoved === 1 ? 'ticket' : 'tickets'} moved`
                  : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <OwnerEditor
        channelId={ownership.channelId}
        owner={owner}
        agents={agents}
        movableTickets={ownership.movableTickets}
      />
    </div>
  );
}
