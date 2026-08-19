import Link from 'next/link';
import { asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, groups } from '@/db/schema';
import { ChannelBadge } from '@/components/channel';
import { Badge, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { ChannelForm } from './forms';

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
                {channel.type === 'whatsapp' || channel.type === 'whatsapp_bot'
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
            className="ms-auto text-sm text-brand-600 hover:underline dark:text-brand-300"
          >
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
