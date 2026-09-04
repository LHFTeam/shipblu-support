'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorText, Input, Label, Select } from '@/components/ui';
import { ROLES_BY_SENIORITY } from '@/lib/auth/permissions';
import { FLOOR_LABELS } from '@/lib/kb/internal';
import { createCategory, createFolder, type KbState } from '../actions';

const INITIAL: KbState = { error: null };

export function CategoryForm() {
  const [state, action] = useActionState(createCategory, INITIAL);

  return (
    <form
      key={state.nonce ?? 0}
      action={action}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] p-4"
    >
      <div className="min-w-40 flex-1">
        <Label htmlFor="categoryName">Name</Label>
        <Input id="categoryName" name="name" placeholder="Tracking a shipment" required />
      </div>

      <div className="w-32">
        <Label htmlFor="categoryLocale">Language</Label>
        <Select id="categoryLocale" name="locale" defaultValue="en">
          <option value="en">English</option>
          <option value="ar">العربية</option>
        </Select>
      </div>

      <div className="min-w-40 flex-1">
        <Label htmlFor="categoryDescription">Description</Label>
        <Input id="categoryDescription" name="description" />
      </div>

      <SubmitButton idle="Add category" busy="Adding…" />
      <ErrorText>{state.error}</ErrorText>
    </form>
  );
}

export function FolderForm({
  categories,
}: {
  categories: { id: string; name: string; locale: string }[];
}) {
  const [state, action] = useActionState(createFolder, INITIAL);
  const [visibility, setVisibility] = useState('public');

  return (
    <form
      key={state.nonce ?? 0}
      action={action}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] p-4"
    >
      <div className="min-w-40 flex-1">
        <Label htmlFor="folderName">Name</Label>
        <Input id="folderName" name="name" placeholder="Delays and exceptions" required />
      </div>

      <div className="min-w-48 flex-1">
        <Label htmlFor="folderCategory">Category</Label>
        <Select id="folderCategory" name="categoryId" defaultValue="" required>
          <option value="" disabled>
            {categories.length ? 'Choose a category…' : 'Create a category first'}
          </option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name} ({category.locale})
            </option>
          ))}
        </Select>
      </div>

      <div className="w-44">
        <Label htmlFor="folderVisibility">Visibility</Label>
        <Select
          id="folderVisibility"
          name="visibility"
          value={visibility}
          onChange={(event) => setVisibility(event.target.value)}
        >
          <option value="public">Public</option>
          <option value="agents_only">Agents only</option>
          <option value="logged_in">Signed-in customers</option>
        </Select>
      </div>

      {/*
        A floor on the folder is the one worth setting: it holds for every
        article filed here afterwards, including one an author left on the
        default. Offered only for an internal folder, because the read rule only
        reads it there.
      */}
      {visibility === 'agents_only' ? (
        <div className="w-52">
          <Label htmlFor="folderMinRole">Who on the team</Label>
          <Select id="folderMinRole" name="minRole" defaultValue="">
            <option value="">Everyone on the team</option>
            {ROLES_BY_SENIORITY.map((role) => (
              <option key={role} value={role}>
                {FLOOR_LABELS[role]}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      <SubmitButton idle="Add folder" busy="Adding…" />
      <ErrorText>{state.error}</ErrorText>
    </form>
  );
}

function SubmitButton({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? busy : idle}
    </Button>
  );
}
