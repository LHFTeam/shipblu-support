'use client';

import { useState } from 'react';
import { Badge, Button, Cell, ErrorText, Input, Row } from '@/components/ui';
import { saveSubcategory, saveRootCause, setSubcategoryActive, setRootCauseActive } from './actions';
import { sentenceCase } from '@/lib/format';

/**
 * One editable row each, for a category and for a cause.
 *
 * Edit-in-place rather than a modal: there are eighty-odd rows between the two
 * tables and the only thing anybody changes is a label, so a dialogue per edit
 * is three clicks for a word.
 *
 * The Arabic input is `dir="rtl"` on the field rather than on the page. The
 * console is English and its layout should stay left-to-right; it is the value
 * being typed that is Arabic, and an Arabic label typed into a left-to-right
 * input puts its punctuation on the wrong end.
 */

type EditableLabels = { labelEn: string; labelAr: string };

function useLabelEditor(
  initial: EditableLabels,
  save: (state: { error: string | null }, formData: FormData) => Promise<{ error: string | null }>,
  id: string,
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commit() {
    setBusy(true);
    setError(null);
    const formData = new FormData();
    formData.set('id', id);
    formData.set('labelEn', draft.labelEn);
    formData.set('labelAr', draft.labelAr);
    const result = await save({ error: null }, formData);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setEditing(false);
  }

  function cancel() {
    setDraft(initial);
    setError(null);
    setEditing(false);
  }

  return { editing, setEditing, draft, setDraft, busy, error, commit, cancel };
}

export function SubcategoryRow({
  category,
  used,
}: {
  category: {
    id: string;
    key: string;
    area: string;
    labelEn: string;
    labelAr: string;
    audience: 'merchant' | 'recipient' | 'any';
    isActive: boolean;
    isDetectable: boolean;
  };
  used: number;
}) {
  const editor = useLabelEditor(
    { labelEn: category.labelEn, labelAr: category.labelAr },
    saveSubcategory,
    category.id,
  );
  const [togglingBusy, setTogglingBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  // The action's answer is read, not dropped: a refusal is a sentence the row
  // has to show, and a throw must not leave the button busy until a reload.
  async function toggle() {
    setTogglingBusy(true);
    setToggleError(null);
    try {
      const formData = new FormData();
      formData.set('id', category.id);
      formData.set('active', category.isActive ? 'false' : 'true');
      const result = await setSubcategoryActive({ error: null }, formData);
      if (result.error) setToggleError(result.error);
    } catch {
      setToggleError('That did not save — reload the page and try again');
    } finally {
      setTogglingBusy(false);
    }
  }

  return (
    <Row>
      <Cell>
        {editor.editing ? (
          <Input
            className="w-full"
            value={editor.draft.labelEn}
            aria-label={`English label for ${category.key}`}
            onChange={(event) => editor.setDraft({ ...editor.draft, labelEn: event.target.value })}
          />
        ) : (
          <>
            {/* A retired row's name is greyed, but not its badges: the word
                "Retired" is what says why, and a dimmed badge would not say it. */}
            <span
              className={`font-medium ${category.isActive ? '' : 'text-(--color-text-tertiary)'}`}
            >
              {category.labelEn}
            </span>
            {!category.isDetectable ? (
              <span className="ms-2">
                <Badge>By hand only</Badge>
              </span>
            ) : null}
            {!category.isActive ? (
              <span className="ms-2">
                <Badge tone="neutral">Retired</Badge>
              </span>
            ) : null}
          </>
        )}
        {editor.error ? (
          <p className="mt-1">
            <ErrorText inline>{editor.error}</ErrorText>
          </p>
        ) : null}
        {toggleError ? (
          <p className="mt-1">
            <ErrorText inline>{toggleError}</ErrorText>
          </p>
        ) : null}
      </Cell>

      <Cell>
        <code className="text-xs text-(--color-text-secondary)">{category.key}</code>
      </Cell>

      <Cell>
        {editor.editing ? (
          <Input
            className="w-full"
            dir="rtl"
            lang="ar"
            value={editor.draft.labelAr}
            aria-label={`Arabic label for ${category.key}`}
            onChange={(event) => editor.setDraft({ ...editor.draft, labelAr: event.target.value })}
          />
        ) : (
          <span dir="rtl" lang="ar" className="text-sm">
            {category.labelAr}
          </span>
        )}
      </Cell>

      <Cell className="text-xs text-(--color-text-secondary)">{category.audience}</Cell>

      {/*
        Zero is not an error and is not styled as one — see the page. It only
        means something next to `by hand only`, which is why that badge exists.
      */}
      <Cell className="text-xs text-(--color-text-secondary)">{used}</Cell>

      <Cell>
        <div className="flex items-center gap-1">
          {editor.editing ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={editor.busy}
                onClick={() => void editor.commit()}
              >
                Save
              </Button>
              <Button variant="ghost" size="sm" onClick={editor.cancel}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={() => editor.setEditing(true)}>
                Rename
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={togglingBusy}
                onClick={() => void toggle()}
              >
                {category.isActive ? 'Retire' : 'Restore'}
              </Button>
            </>
          )}
        </div>
      </Cell>
    </Row>
  );
}

export function RootCauseRow({
  cause,
}: {
  cause: {
    id: string;
    key: string;
    labelEn: string;
    labelAr: string;
    owner: string;
    isActive: boolean;
  };
}) {
  const editor = useLabelEditor(
    { labelEn: cause.labelEn, labelAr: cause.labelAr },
    saveRootCause,
    cause.id,
  );
  const [togglingBusy, setTogglingBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  // The action's answer is read, not dropped: a refusal is a sentence the row
  // has to show, and a throw must not leave the button busy until a reload.
  async function toggle() {
    setTogglingBusy(true);
    setToggleError(null);
    try {
      const formData = new FormData();
      formData.set('id', cause.id);
      formData.set('active', cause.isActive ? 'false' : 'true');
      const result = await setRootCauseActive({ error: null }, formData);
      if (result.error) setToggleError(result.error);
    } catch {
      setToggleError('That did not save — reload the page and try again');
    } finally {
      setTogglingBusy(false);
    }
  }

  return (
    <Row>
      <Cell>
        {editor.editing ? (
          <Input
            className="w-full"
            value={editor.draft.labelEn}
            aria-label={`English label for ${cause.key}`}
            onChange={(event) => editor.setDraft({ ...editor.draft, labelEn: event.target.value })}
          />
        ) : (
          <>
            {/* A retired row's name is greyed, but not its badges: the word
                "Retired" is what says why, and a dimmed badge would not say it. */}
            <span className={`font-medium ${cause.isActive ? '' : 'text-(--color-text-tertiary)'}`}>
              {cause.labelEn}
            </span>
            {!cause.isActive ? (
              <span className="ms-2">
                <Badge tone="neutral">Retired</Badge>
              </span>
            ) : null}
          </>
        )}
        {editor.error ? (
          <p className="mt-1">
            <ErrorText inline>{editor.error}</ErrorText>
          </p>
        ) : null}
        {toggleError ? (
          <p className="mt-1">
            <ErrorText inline>{toggleError}</ErrorText>
          </p>
        ) : null}
      </Cell>

      <Cell>
        <code className="text-xs text-(--color-text-secondary)">{cause.key}</code>
      </Cell>

      <Cell>
        {editor.editing ? (
          <Input
            className="w-full"
            dir="rtl"
            lang="ar"
            value={editor.draft.labelAr}
            aria-label={`Arabic label for ${cause.key}`}
            onChange={(event) => editor.setDraft({ ...editor.draft, labelAr: event.target.value })}
          />
        ) : (
          <span dir="rtl" lang="ar" className="text-sm">
            {cause.labelAr}
          </span>
        )}
      </Cell>

      {/*
        Shown, never editable. The key's prefix names the owner and a CHECK holds
        the two together, so an edit here would be rejected by the database
        rather than accepted and wrong — which is the right outcome, but a
        control that always fails is worse than no control.
      */}
      <Cell>
        <Badge>{sentenceCase(cause.owner)}</Badge>
      </Cell>

      <Cell>
        <div className="flex items-center gap-1">
          {editor.editing ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={editor.busy}
                onClick={() => void editor.commit()}
              >
                Save
              </Button>
              <Button variant="ghost" size="sm" onClick={editor.cancel}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={() => editor.setEditing(true)}>
                Rename
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={togglingBusy}
                onClick={() => void toggle()}
              >
                {cause.isActive ? 'Retire' : 'Restore'}
              </Button>
            </>
          )}
        </div>
      </Cell>
    </Row>
  );
}
