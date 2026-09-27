'use client';

import { useState } from 'react';
import { Badge, Field, Button, Input, Toggle } from '@/components/ui';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteWhatsAppAccount, saveWhatsAppAccount } from './actions';

/**
 * Connecting a WhatsApp Business Account.
 *
 * The form is three ids and a switch, and every one of them is a thing an admin
 * copies out of Meta rather than invents — so each field says where it comes
 * from and what goes wrong when it is the wrong one. The token is the exception:
 * it is not entered here at all, only *named*, and the hint has to carry that
 * because a box labelled "access token" that refuses an access token is
 * otherwise just broken.
 */

export type WhatsAppAccountRow = {
  id: string;
  name: string;
  wabaId: string;
  tokenEnvVar: string | null;
  isDefault: boolean;
  isActive: boolean;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
  numbers: string[];
  /** Approved, which is what an agent can pick from. */
  templateCount: number;
  /** Every row the sync has stored, whatever its status. Zero is the interesting case. */
  templateTotal: number;
};

function Fields({
  account,
  suggestedWabaId,
  isFirst,
}: {
  account?: WhatsAppAccountRow;
  suggestedWabaId?: string | null;
  isFirst: boolean;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint="Shown wherever a number has to say which business it belongs to.">
          <Input name="name" defaultValue={account?.name} required placeholder="ShipBlu Egypt" />
        </Field>

        <Field
          label="WhatsApp Business Account ID"
          explain={
            <>
              The numeric WABA id from Meta&rsquo;s WhatsApp Manager — Account tools → Business
              account ID. Not the phone number and not the phone number ID. Templates are listed
              against it, so a wrong one syncs nothing and the console offers agents no templates at
              all.
            </>
          }
        >
          <Input
            name="wabaId"
            defaultValue={account?.wabaId ?? suggestedWabaId ?? ''}
            required
            inputMode="numeric"
            placeholder="102290129340398"
          />
        </Field>
      </div>

      <Field
        label="Access token variable"
        explain={
          <>
            The <em>name</em> of the environment variable holding this account&rsquo;s access token,
            never the token itself — so a database dump carries no usable credential. It must start{' '}
            <code>WHATSAPP_TOKEN_</code>, and the value is set in the
            <code> shipblu-support-production</code> environment group on Render.
          </>
        }
        hint="Leave blank when this account is reachable with the shared META_PAGE_ACCESS_TOKEN, which is the case whenever the accounts sit under one Meta app."
      >
        <Input
          name="tokenEnvVar"
          defaultValue={account?.tokenEnvVar ?? ''}
          placeholder="WHATSAPP_TOKEN_EGYPT"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      <Toggle
        name="isDefault"
        label="Use this account by default"
        hint="Used when nothing else names one — an outbound-first template send on a ticket with no inbound history. Turning it on turns it off everywhere else."
        defaultChecked={account?.isDefault ?? isFirst}
      />

      <Toggle
        name="isActive"
        label="Connected"
        hint="Switched off, its templates stop syncing. Numbers already pointed at it keep using it — replying from a different business account is a message Meta rejects, quietly, on a status webhook."
        defaultChecked={account?.isActive ?? true}
      />
    </>
  );
}

export function NewWhatsAppAccount({
  suggestedWabaId,
  isFirst,
}: {
  suggestedWabaId: string | null;
  isFirst: boolean;
}) {
  return (
    <Disclosure label="Connect a WhatsApp business account">
      {(close) => (
        <EditorForm action={saveWhatsAppAccount} submitLabel="Connect" onSaved={close}>
          <Fields suggestedWabaId={suggestedWabaId} isFirst={isFirst} />
        </EditorForm>
      )}
    </Disclosure>
  );
}

export function WhatsAppAccountEditor({ account }: { account: WhatsAppAccountRow }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditorForm
        action={saveWhatsAppAccount}
        submitLabel="Save connection"
        onSaved={() => setEditing(false)}
      >
        <input type="hidden" name="id" value={account.id} />
        <Fields account={account} isFirst={false} />
      </EditorForm>
    );
  }

  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {account.name}
          {account.isDefault ? <Badge tone="brand">default</Badge> : null}
          {!account.isActive ? <Badge tone="neutral">off</Badge> : null}
          {/* The failure this row exists to make visible. A connection whose
              token cannot read it looks exactly like a working one on every
              other screen, and the difference only shows up when an agent's
              template send fails hours later. */}
          {account.lastSyncError ? <Badge tone="danger">sync failing</Badge> : null}
          {account.isActive && !account.lastSyncedAt && !account.lastSyncError ? (
            <Badge tone="warning">never synced</Badge>
          ) : null}
          {/* A sync that succeeds and reads back nothing, every hour, for ever.
              Meta answers 200 with an empty list both for a WABA that holds no
              templates and for an id that is not the WABA anybody meant — so on
              every other signal this row carries it is indistinguishable from a
              healthy one, which is why it needs a signal of its own. */}
          {account.isActive &&
          account.lastSyncedAt &&
          !account.lastSyncError &&
          account.templateTotal === 0 ? (
            <Badge tone="warning">no templates</Badge>
          ) : null}
        </h3>

        <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
          {account.wabaId} · {account.tokenEnvVar ?? 'META_PAGE_ACCESS_TOKEN'} ·{' '}
          {account.numbers.length === 0 ? 'no numbers yet' : `${account.numbers.join(', ')}`} ·{' '}
          {account.templateCount} template{account.templateCount === 1 ? '' : 's'}
        </p>

        {account.lastSyncError ? (
          <p className="mt-1 text-xs text-red-600">{account.lastSyncError}</p>
        ) : account.lastSyncedAt && account.templateTotal === 0 ? (
          <p className="mt-1 text-xs text-amber-600">
            Meta answered and returned no templates at all. Check that {account.wabaId} is the
            WhatsApp Business Account ID from WhatsApp Manager — an id that is not a WABA, or one
            belonging to a business this token cannot manage, answers exactly the same way an empty
            account does.
          </p>
        ) : account.lastSyncedAt ? (
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">
            Templates last synced{' '}
            {account.lastSyncedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC
          </p>
        ) : (
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">
            Templates sync hourly; nothing has been read from this account yet.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <DangerAction action={deleteWhatsAppAccount} id={account.id} label="Disconnect" />
      </div>
    </div>
  );
}
