import { asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, groups } from '@/db/schema';
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
        <h1 className="mb-1 text-lg font-semibold">Channels</h1>
        <p className="mb-3 text-sm opacity-60">
          Addresses and routing only. Access tokens and webhook secrets live in the environment, so
          they are never stored in the database.
        </p>

        <ul className="mb-4 divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] text-sm">
          {channelList.length === 0 ? (
            <li className="px-3 py-2.5 opacity-50">No channels configured yet.</li>
          ) : null}
          {channelList.map((channel) => (
            <li key={channel.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="font-medium">{channel.name}</span>
              <span className="opacity-50">{channel.type}</span>
              <span className="ml-auto text-xs opacity-50">
                {channel.type === 'whatsapp'
                  ? (channel.config.phoneNumberId as string) || 'no phone number id'
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
