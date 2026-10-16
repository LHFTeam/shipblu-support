'use client';

import { useState } from 'react';
import {
  Badge,
  Button,
  buttonClass,
  ErrorText,
  Field,
  Input,
  Select,
  SuccessText,
  Toggle,
} from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';
import type { WordingRule } from '@/lib/csat/rules';
import {
  DEFAULT_WORDING,
  EMPTY_WORDING_PAIR,
  ratingLabels,
  resolveWording,
  WORDING_FIELDS,
  WORDING_LIMITS,
  wordingColumn,
  wordingLength,
  wordingProblem,
  type WordingField,
  type WordingLocale,
  type WordingPair,
} from '@/lib/csat/wording';
import type { ActionState } from '@/lib/http/action-state';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteWordingRule, saveWordingRule, sendTestSurvey } from './actions';

type Group = { id: string; name: string };

/**
 * The channels a survey goes out on. Matches the list the action validates
 * against — an option here the action rejects is a form that fails on save
 * for no reason the admin can see.
 */
const CHANNELS: { value: string; label: string }[] = [
  { value: 'email', label: 'Email' },
  { value: 'webchat', label: 'Web chat' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'portal', label: 'Customer portal' },
  { value: 'api', label: 'API' },
];

function channelLabel(value: string | null): string {
  return CHANNELS.find((channel) => channel.value === value)?.label ?? 'Every channel';
}

const PLACEHOLDERS: Record<WordingLocale, Record<WordingField, string>> = {
  en: DEFAULT_WORDING.en,
  ar: DEFAULT_WORDING.ar,
};

/**
 * The twelve strings, each counted against its Meta limit as it is typed.
 *
 * Controlled, so the counters and the preview below follow the keystrokes;
 * `useActionForm`'s reset does not touch a controlled input, so a refusal
 * keeps what was typed. The names are the column names, which is what the
 * action reads back.
 */
function WordingFields({
  pair,
  onChange,
}: {
  pair: WordingPair;
  onChange: (pair: WordingPair) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {WORDING_FIELDS.map((field) => {
        const limit = WORDING_LIMITS[field];
        return (
          <Field
            key={field}
            label={limit.label}
            as="group"
            hint={
              limit.max === null
                ? 'Any length.'
                : `Up to ${limit.max} characters${limit.min ? `, at least ${limit.min}` : ''}; no links.`
            }
            explain={EXPLAIN[field]}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {(['ar', 'en'] as const).map((locale) => {
                const column = wordingColumn(field, locale);
                const value = pair[column];
                const problem = wordingProblem(field, value);
                return (
                  <div key={column} className="flex flex-col gap-1">
                    <Input
                      name={column}
                      value={value}
                      dir={locale === 'ar' ? 'rtl' : 'ltr'}
                      lang={locale}
                      aria-label={`${limit.label}, ${locale === 'ar' ? 'Arabic' : 'English'}`}
                      placeholder={PLACEHOLDERS[locale][field]}
                      aria-invalid={problem ? true : undefined}
                      className={problem ? '!border-(--color-feedback-danger-fg)' : ''}
                      onChange={(event) => onChange({ ...pair, [column]: event.target.value })}
                    />
                    <span
                      className={`text-2xs ${problem ? 'text-(--color-feedback-danger-fg)' : 'text-(--color-text-tertiary)'}`}
                    >
                      {limit.max === null
                        ? `${wordingLength(value)}`
                        : `${wordingLength(value)} / ${limit.max}`}
                      {problem ? ` — ${problem}` : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          </Field>
        );
      })}
    </div>
  );
}

const EXPLAIN: Record<WordingField, string> = {
  question:
    'The question itself: the email’s heading, the chat card’s question, and the question on Messenger’s feedback card. Required in at least one language; the other falls back to it.',
  intro:
    'The first line of the email and the chat card, and the title of Messenger’s card. Leave it empty to use the built-in line.',
  subtitle: 'The second line of the email, and the subtitle of Messenger’s card.',
  button:
    'The button that sends the answer on the page and the card, and the button on Messenger’s card.',
  commentPrompt: 'The label above the comment box; the placeholder of Messenger’s follow-up.',
  thanks: 'Shown after the customer answers. Never reaches Meta, so it has no limit.',
};

/**
 * The rule three ways, as the strings on screen will be used: the email, the
 * chat card, and the slots of Messenger’s card with their limits — Meta
 * draws that one, so the preview shows what goes in each slot rather than
 * pretending to draw it.
 */
export function WordingPreview({ pair, locale }: { pair: WordingPair; locale: WordingLocale }) {
  const wording = resolveWording(pair, locale);
  const labels = ratingLabels(locale);
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  return (
    <div className="grid gap-3 lg:grid-cols-3" dir={dir}>
      <div className="rounded-lg border border-(--color-border-subtle) p-3 text-sm">
        <p className="mb-2 text-2xs font-semibold tracking-wide text-(--color-text-tertiary) uppercase">
          Email
        </p>
        <p>{wording.intro}</p>
        <p>{wording.subtitle}</p>
        <p className="mt-2 font-semibold">{wording.question}</p>
        <p className="mt-2 flex flex-wrap gap-1">
          {labels.map((label) => (
            <span
              key={label}
              className="rounded-md border border-(--color-border-default) px-2 py-1 text-xs"
            >
              {label}
            </span>
          ))}
        </p>
      </div>

      <div className="rounded-lg border border-(--color-border-subtle) p-3 text-sm">
        <p className="mb-2 text-2xs font-semibold tracking-wide text-(--color-text-tertiary) uppercase">
          Chat card
        </p>
        <p className="text-(--color-text-secondary)">{wording.intro}</p>
        <p className="font-semibold">{wording.question}</p>
        <p className="mt-2 flex flex-wrap gap-1">
          {labels.map((label) => (
            <span
              key={label}
              className="rounded-md border border-(--color-border-default) px-2 py-1 text-xs"
            >
              {label}
            </span>
          ))}
        </p>
        <p className="mt-2 text-xs text-(--color-text-secondary)">{wording.commentPrompt}</p>
        <p className="mt-1">
          <span className={buttonClass({ variant: 'primary', size: 'sm' })}>{wording.button}</span>
        </p>
        <p className="mt-2 text-xs text-(--color-text-secondary)">{wording.thanks}</p>
      </div>

      <div className="rounded-lg border border-(--color-border-subtle) p-3 text-sm">
        <p className="mb-2 text-2xs font-semibold tracking-wide text-(--color-text-tertiary) uppercase">
          Messenger card
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {(
            [
              ['Title', 'intro'],
              ['Subtitle', 'subtitle'],
              ['Button', 'button'],
              ['Question', 'question'],
              ['Placeholder', 'commentPrompt'],
            ] as const
          ).map(([slot, field]) => {
            const max = WORDING_LIMITS[field].max;
            const over = max !== null && wordingLength(wording[field]) > max;
            return (
              <div key={slot} className="contents">
                <dt className="text-(--color-text-tertiary)">{slot}</dt>
                <dd className={over ? 'text-(--color-feedback-danger-fg)' : ''}>
                  {wording[field]}{' '}
                  <span className="text-(--color-text-tertiary)">
                    ({wordingLength(wording[field])}
                    {max !== null ? ` / ${max}` : ''})
                  </span>
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </div>
  );
}

function RuleFields({
  rule,
  groups,
  prefill = false,
}: {
  rule?: WordingRule;
  groups: Group[];
  /** Start from the built-in strings rather than empty: "Customise" edits what goes out today. */
  prefill?: boolean;
}) {
  const [pair, setPair] = useState<WordingPair>(() =>
    rule ? pick(rule) : prefill ? builtInPair() : { ...EMPTY_WORDING_PAIR },
  );
  const [previewLocale, setPreviewLocale] = useState<WordingLocale>('ar');

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Group"
          explain="Which team’s tickets this covers. The most specific rule wins: a channel beats a group, and a rule naming both beats either."
        >
          <Select name="groupId" defaultValue={rule?.groupId ?? ''}>
            <option value="">Every group</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Channel"
          explain="Scope the wording to one channel. Facebook’s card has the tightest limits, which every rule is held to anyway, because a rule with no channel reaches Facebook too."
        >
          <Select name="channel" defaultValue={rule?.channel ?? ''}>
            <option value="">Every channel</option>
            {CHANNELS.map((channel) => (
              <option key={channel.value} value={channel.value}>
                {channel.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <WordingFields pair={pair} onChange={setPair} />

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-(--color-text-secondary)">
          Preview
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPreviewLocale(previewLocale === 'ar' ? 'en' : 'ar')}
          >
            {previewLocale === 'ar' ? 'Show English' : 'Show Arabic'}
          </Button>
        </div>
        <WordingPreview pair={pair} locale={previewLocale} />
      </div>

      <Toggle
        name="isActive"
        label="Active"
        hint="Turned off, this rule stops matching and its tickets fall back to the next broadest one — or to the built-in wording."
        defaultChecked={rule?.isActive ?? true}
      />
    </>
  );
}

/** The built-in wording as a pair, for a rule that starts as a copy of it. */
function builtInPair(): WordingPair {
  const pair = {} as WordingPair;
  for (const field of WORDING_FIELDS) {
    for (const locale of ['ar', 'en'] as const) {
      pair[wordingColumn(field, locale)] = DEFAULT_WORDING[locale][field];
    }
  }
  return pair;
}

function pick(rule: WordingRule): WordingPair {
  const pair = {} as WordingPair;
  for (const field of WORDING_FIELDS) {
    for (const locale of ['ar', 'en'] as const) {
      const column = wordingColumn(field, locale);
      pair[column] = rule[column];
    }
  }
  return pair;
}

export function NewWordingRule({ groups }: { groups: Group[] }) {
  return (
    <Disclosure label="New wording">
      {(close) => (
        <EditorForm action={saveWordingRule} submitLabel="Create wording" onSaved={close}>
          <RuleFields groups={groups} />
        </EditorForm>
      )}
    </Disclosure>
  );
}

export function WordingRuleEditor({ rule, groups }: { rule: WordingRule; groups: Group[] }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditorForm action={saveWordingRule} submitLabel="Save" onSaved={() => setEditing(false)}>
        <input type="hidden" name="id" value={rule.id} />
        <RuleFields rule={rule} groups={groups} />
      </EditorForm>
    );
  }

  const group = groups.find((candidate) => candidate.id === rule.groupId);
  const question = rule.questionEn.trim() || rule.questionAr.trim();

  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          {channelLabel(rule.channel)}
          <span className="font-normal text-(--color-text-secondary)">·</span>
          {group ? group.name : 'Every group'}
          {rule.isActive ? null : <Badge tone="neutral">Off</Badge>}
        </h2>
        <p className="mt-1 line-clamp-2 text-xs text-(--color-text-secondary)">{question}</p>
      </div>

      <div className="ms-auto flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <DangerAction
          action={deleteWordingRule}
          id={rule.id}
          label="Delete"
          confirmLabel="Delete wording"
        />
      </div>
    </div>
  );
}

/** The built-in wording, shown as the row that answers when no rule does. */
export function BuiltInWording({
  groups,
  customisable,
}: {
  groups: Group[];
  /** False while a switched-off every-group, every-channel rule holds that scope: edit that one instead. */
  customisable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [locale, setLocale] = useState<WordingLocale>('ar');

  if (editing) {
    return (
      <EditorForm
        action={saveWordingRule}
        submitLabel="Create wording"
        onSaved={() => setEditing(false)}
      >
        <RuleFields groups={groups} prefill />
      </EditorForm>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            Every channel
            <span className="font-normal text-(--color-text-secondary)">·</span>
            Every group
            <Badge tone="neutral">Built in</Badge>
            <InfoTip label="Built in">
              What goes out when no rule matches a ticket, and what fills any line a rule leaves
              empty in both languages. Customise it by creating a rule for every group and every
              channel.
            </InfoTip>
          </h2>
          <p className="mt-1 text-xs text-(--color-text-secondary)">
            {DEFAULT_WORDING.en.question} · {DEFAULT_WORDING.ar.question}
          </p>
        </div>
        <div className="ms-auto flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}
          >
            {locale === 'ar' ? 'Show English' : 'Show Arabic'}
          </Button>
          {customisable ? (
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Customise
            </Button>
          ) : null}
        </div>
      </div>
      <WordingPreview pair={EMPTY_WORDING_PAIR} locale={locale} />
    </div>
  );
}

const TEST_INITIAL: ActionState = { error: null };

/**
 * Emails the admin the survey as a customer would get it. The address is the
 * admin's own and is not a field: a form that mails any address is a form
 * that mails a customer.
 */
export function SendTestForm({
  rules,
  groups,
  email,
}: {
  rules: WordingRule[];
  groups: Group[];
  email: string;
}) {
  const { state, form } = useActionForm(sendTestSurvey, TEST_INITIAL);

  return (
    <form {...form} className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field className="sm:w-64" label="Wording">
          <Select name="ruleId" defaultValue="">
            <option value="">Built in</option>
            {rules.map((rule) => (
              <option key={rule.id} value={rule.id}>
                {channelLabel(rule.channel)} ·{' '}
                {groups.find((group) => group.id === rule.groupId)?.name ?? 'Every group'}
              </option>
            ))}
          </Select>
        </Field>
        <Field className="sm:w-40" label="Language">
          <Select name="locale" defaultValue="ar">
            <option value="ar">Arabic</option>
            <option value="en">English</option>
          </Select>
        </Field>
        <SubmitButton idle={`Email me a test`} busy="Sending…" className="self-start" />
      </div>
      <p className="text-xs text-(--color-text-secondary)">
        Sent to {email}. Its links open the survey page as a customer would see it, and record
        nothing.
      </p>
      <ErrorText>{state.error}</ErrorText>
      {state.ok ? <SuccessText>On its way.</SuccessText> : null}
    </form>
  );
}
