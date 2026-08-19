import { asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, groups } from '@/db/schema';
import { ChannelBadge } from '@/components/channel';
import { Badge, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { ChannelForm, GroupForm } from './forms';

export const dynamic = 'force-dynamic';

export default async function ChannelsPage() {
  await requirePermission('admin.channels');

  const [channelList, groupList] = await Promise.all([
    db
      .select({
        id: channels.id,
        type: channels.type,
        name: channels.name,
        config: channels.config,
        defaultGroupId: channels.defaultGroupId,
        isActive: channels.isActive,
      })
      .from(channels)
      .orderBy(asc(channels.name)),

    db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(asc(groups.name)),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <section>
        <PageHeader
          title="Channels"
          description="Addresses and routing only. Access tokens and webhook secrets live in the environment, so a database dump never contains a usable credential."
        />

        <ul className="mb-4 divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface)] text-sm">
          {channelList.length === 0 ? (
            <li className="px-3 py-2.5 text-[var(--muted-foreground)]">
              No channels configured yet. Tickets still arrive; they just have no default group.
            </li>
          ) : null}
          {channelList.map((channel) => (
            <li key={channel.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <ChannelBadge channel={channel.type} />
              <span className="font-medium">{channel.name}</span>
              {!channel.isActive ? <Badge tone="neutral">inactive</Badge> : null}
              <span className="ms-auto text-xs text-[var(--muted-foreground)]">
                {channel.type === 'whatsapp'
                  ? (channel.config.phoneNumberId as string) || 'no phone number id'
                  : channel.type === 'facebook' || channel.type === 'instagram'
                    ? 'configured in the environment'
                    : channel.type === 'webchat'
                      ? 'the widget'
                      : (channel.config.address as string) || 'no address'}
              </span>
            </li>
          ))}
        </ul>

        <ChannelForm groups={groupList} />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Groups</h2>
        <ul className="mb-4 divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] text-sm">
          {groupList.length === 0 ? (
            <li className="px-3 py-2.5 opacity-50">No groups yet.</li>
          ) : null}
          {groupList.map((group) => (
            <li key={group.id} className="px-3 py-2.5">
              {group.name}
            </li>
          ))}
        </ul>

        <GroupForm />
      </section>
    </div>
  );
}
