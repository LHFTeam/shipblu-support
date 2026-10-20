import { useState, type FormEvent, type ReactNode } from 'react';
import { ShipBluLogo } from '@/components/brand';
import { ExternalIcon, HubIcon, PackageIcon } from '@/components/icons';
import { Button, EmptyState, ErrorText, Field, Input, Notice } from '@/components/ui';
import type { ChatState } from '../messages';
import {
  claimTicket,
  consoleUrl,
  readToken,
  resolveChat,
  signIn,
  signOut,
  whoAmI,
  type ResolvedTicket,
} from './api';
import { SignedOutContext, useChat, usePolled, useWrite } from './hooks';
import { ShipmentsTab } from './Shipments';
import { SideConversationsTab } from './SideConversations';

/**
 * The side panel: signed out, it is a sign-in form; signed in, it follows the
 * chat open in WhatsApp Web and shows that chat's ticket.
 */
export function App() {
  const [token, setToken] = useState(() => readToken());

  if (!token) return <SignIn onSignedIn={() => setToken(readToken())} />;

  return (
    <SignedOutContext.Provider value={() => setToken(null)}>
      <SignedIn onSignedOut={() => setToken(null)} />
    </SignedOutContext.Provider>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const write = useWrite();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await write.run(() => signIn(email, password))) onSignedIn();
  }

  return (
    <main className="flex min-h-full flex-col gap-4 p-4">
      <header className="flex items-center gap-2">
        <ShipBluLogo className="size-8" />
        <h1 className="text-base font-semibold">ShipBlu Support</h1>
      </header>
      <p className="text-sm text-(--color-text-secondary)">
        Sign in with your ShipBlu Support account to see the ticket for the chat you are answering.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Email">
          <Input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <ErrorText>{write.error}</ErrorText>
        <Button type="submit" disabled={write.busy} loading={write.busy}>
          {write.busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </main>
  );
}

function SignedIn({ onSignedOut }: { onSignedOut: () => void }) {
  // Who is signed in, re-asked every five minutes: a deactivated agent's next
  // answer is a 401, which returns the panel to the sign-in form.
  const me = usePolled('me', whoAmI, 5 * 60_000);
  const chat = useChat();

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center gap-2 border-b border-(--color-border-subtle) bg-(--color-background-surface) px-3 py-2">
        <ShipBluLogo className="size-6" />
        <span className="min-w-0 flex-1 truncate text-xs text-(--color-text-secondary)">
          {me.data ? me.data.agent.name : ' '}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void signOut().finally(onSignedOut);
          }}
        >
          Sign out
        </Button>
      </header>
      <main className="flex flex-1 flex-col gap-3 p-3">
        <ChatTicket connection={chat} />
      </main>
    </div>
  );
}

function ChatTicket({ connection }: { connection: ReturnType<typeof useChat> }) {
  if (connection.status === 'connecting') {
    return <p className="text-sm text-(--color-text-secondary)">Reading WhatsApp Web…</p>;
  }
  if (connection.status === 'unreachable') {
    return (
      <Notice tone="warning" icon>
        The extension cannot read this tab yet. Reload WhatsApp Web (Ctrl+R) — it was open before
        the extension was installed or updated.
      </Notice>
    );
  }
  const { state } = connection;
  if (state.keys === null) {
    return (
      <EmptyState
        title="Open a chat"
        hint="Its ticket's shipments and side conversations will show here."
      />
    );
  }
  if (state.keys.length === 0) {
    return (
      <EmptyState
        title="No messages yet"
        hint="A chat is matched to its ticket by its messages, and this one has none on screen."
      />
    );
  }
  return <ResolvedChat state={state} />;
}

function ResolvedChat({ state }: { state: ChatState }) {
  // Keyed on the newest few messages: a new message re-asks, scrolling up to
  // load older ones does not.
  const key = `resolve:${state.me ?? ''}:${(state.keys ?? []).slice(-5).join(',')}`;
  const resolved = usePolled(key, () => resolveChat(state), 60_000);

  if (resolved.loading) {
    return (
      <p className="text-sm text-(--color-text-secondary)">Finding this chat&apos;s ticket…</p>
    );
  }
  if (resolved.error?.status === 404) {
    return (
      <Notice tone="info" icon>
        Matching WhatsApp Web chats to tickets is not live yet. It needs the console update that
        follows this one.
      </Notice>
    );
  }
  if (resolved.error) return <ErrorText>{resolved.error.message}</ErrorText>;
  if (!resolved.data) {
    return (
      <EmptyState
        title="No ticket for this chat yet"
        hint="None of the messages on screen has reached ShipBlu Support. A new message can take a few seconds; a chat from before the number was connected has no ticket."
      />
    );
  }
  if (!resolved.data.visible) return <Claim ticket={resolved.data} onClaimed={resolved.reload} />;
  return <Ticket ticket={resolved.data} />;
}

/**
 * "Take this ticket", for a chat whose ticket the agent cannot see yet.
 * `lib/extension/claim.ts` says what it may and may not take.
 */
function Claim({
  ticket,
  onClaimed,
}: {
  ticket: Extract<ResolvedTicket, { visible: false }>;
  onClaimed: () => void;
}) {
  const write = useWrite();

  if (ticket.assigneeName) {
    return (
      <Notice tone="info" icon>
        This chat&apos;s ticket is assigned to {ticket.assigneeName}. Ask them or a supervisor to
        reassign it to you.
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-(--color-border-default) bg-(--color-background-surface) p-3">
      <p className="text-sm">
        This chat&apos;s ticket is not assigned to anyone. Take it to see its shipments and side
        conversations.
      </p>
      <ErrorText>{write.error}</ErrorText>
      <Button
        disabled={write.busy}
        loading={write.busy}
        onClick={() => {
          void write.run(() => claimTicket(ticket.id)).then((ok) => ok && onClaimed());
        }}
      >
        {write.busy ? 'Taking it…' : 'Take this ticket'}
      </Button>
    </div>
  );
}

type Tab = 'shipments' | 'side';

function Ticket({ ticket }: { ticket: Extract<ResolvedTicket, { visible: true }> }) {
  const [tab, setTab] = useState<Tab>('shipments');

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-(--color-text-secondary)">
            Ticket #{ticket.number}
            {ticket.requesterName ? ` · ${ticket.requesterName}` : ''}
          </p>
          <h2 dir="auto" className="truncate text-start text-sm font-semibold">
            {ticket.subject ?? 'No subject'}
          </h2>
        </div>
        <a
          href={consoleUrl(`/inbox/${ticket.number}`)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-(--color-text-link) hover:underline"
        >
          Console
          <ExternalIcon size={12} />
        </a>
      </div>

      <div role="tablist" className="flex gap-1 border-b border-(--color-border-subtle)">
        <TabButton
          current={tab}
          value="shipments"
          onSelect={setTab}
          icon={<PackageIcon size={14} />}
        >
          Shipments
        </TabButton>
        <TabButton current={tab} value="side" onSelect={setTab} icon={<HubIcon size={14} />}>
          Side conversations
        </TabButton>
      </div>

      {tab === 'shipments' ? (
        <ShipmentsTab ticketId={ticket.id} />
      ) : (
        <SideConversationsTab ticketId={ticket.id} ticketSubject={ticket.subject} />
      )}
    </section>
  );
}

function TabButton({
  current,
  value,
  onSelect,
  icon,
  children,
}: {
  current: Tab;
  value: Tab;
  onSelect: (tab: Tab) => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  const selected = current === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={() => onSelect(value)}
      className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-2 py-1.5 text-xs font-medium ${
        selected
          ? 'border-(--color-text-link) text-(--color-text-primary)'
          : 'border-transparent text-(--color-text-secondary) hover:text-(--color-text-primary)'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
