import { ChannelBadge } from '@/components/channel';
import { Cell, EmptyState, Row, Table } from '@/components/ui';
import type { ChannelLoad as ChannelLoadRow } from '@/lib/reports/live';

import { Section } from './section';

export function ChannelLoad({ channels }: { channels: ChannelLoadRow[] }) {
  return (
    <Section title="Open work by channel" hint="Live, across the same open backlog.">
      {channels.length === 0 ? (
        <EmptyState title="Nothing open" hint="Every conversation has been resolved or closed." />
      ) : (
        <Table head={['Channel', 'Open', 'Waiting on us']}>
          {channels.map((channel) => (
            <Row key={channel.channel}>
              <Cell>
                <ChannelBadge channel={channel.channel} />
              </Cell>
              <Cell>{channel.open.toLocaleString('en-GB')}</Cell>
              <Cell>{channel.awaitingReply.toLocaleString('en-GB')}</Cell>
            </Row>
          ))}
        </Table>
      )}
    </Section>
  );
}
