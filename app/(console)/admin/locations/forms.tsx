'use client';

import { useState } from 'react';
import { Badge, Field, Input, Toggle } from '@/components/ui';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteLocation, saveLocation } from './actions';

type Location = {
  id: string;
  name: string;
  code: string;
  email: string;
  isActive: boolean;
};

/**
 * The three facts a location is, and one switch.
 *
 * The code is shown as typed rather than transformed live: it is uppercased on
 * save, and a field that rewrites what somebody is halfway through typing reads
 * as a bug. The hint says what will happen instead.
 */
function Fields({ location }: { location?: Location }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input
            name="name"
            defaultValue={location?.name}
            required
            placeholder="Cairo — Nasr City"
          />
        </Field>
        <Field label="Code" hint="Short, unique, and uppercased when saved. For example CAI-1.">
          <Input name="code" defaultValue={location?.code} required placeholder="CAI-1" />
        </Field>
      </div>

      <Field
        label="Email"
        hint="The shared mailbox that reaches whoever is at this location. On the record for escalating and copying by hand — nothing routes customer mail to it."
      >
        <Input
          name="email"
          type="email"
          defaultValue={location?.email}
          required
          placeholder="nasrcity@shipblu.com"
        />
      </Field>

      <Toggle
        name="isActive"
        label="Operating"
        hint="Turn this off for a location that has closed. Its row stays, so its code still reads in older tickets."
        defaultChecked={location?.isActive ?? true}
      />
    </>
  );
}

export function NewLocation() {
  return (
    <Disclosure label="New location">
      {(close) => (
        <EditorForm action={saveLocation} submitLabel="Create location" onSaved={close}>
          <Fields />
        </EditorForm>
      )}
    </Disclosure>
  );
}

export function LocationEditor({
  location,
  deleteOnly = false,
}: {
  location: Location;
  deleteOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (deleteOnly) return <DangerAction action={deleteLocation} id={location.id} />;

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="text-start hover:underline">
        <span className="font-medium">{location.name}</span>
        {!location.isActive ? (
          <span className="ms-2">
            <Badge tone="neutral">closed</Badge>
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <EditorForm action={saveLocation} submitLabel="Save" onSaved={() => setEditing(false)}>
      <input type="hidden" name="id" value={location.id} />
      <Fields location={location} />
    </EditorForm>
  );
}
