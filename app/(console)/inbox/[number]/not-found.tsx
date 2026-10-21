import Link from 'next/link';
import { buttonClass, Card } from '@/components/ui';

/**
 * What an agent sees for a ticket number that leads nowhere they may go.
 *
 * The page answers a ticket they may not see exactly as one that does not
 * exist, deliberately, so this says nothing about which it was. What it does
 * say is the common way here: a ticket open on screen leaves an agent's sight
 * when somebody else hands it to another group or agent, or a rule does, and
 * the next live refresh lands here. The framework's bare 404 said neither why
 * nor where to go next. An agent's own move of it never gets here:
 * `updateTicket` sends them to the inbox instead.
 */
export default function TicketNotFound() {
  return (
    <div className="app-scroll relative h-full overflow-y-auto p-6">
      <Card className="mx-auto mt-10 max-w-md text-center">
        <h1 className="text-lg font-semibold text-(--color-text-primary)">
          No ticket you can see has this number
        </h1>
        <p className="mt-2 text-sm text-(--color-text-secondary)">
          If it was open a moment ago, it has probably been moved to another group or handed to
          somebody else. Otherwise the number may be wrong.
        </p>
        <Link href="/inbox" className={`mt-6 ${buttonClass()}`}>
          Back to the inbox
        </Link>
      </Card>
    </div>
  );
}
