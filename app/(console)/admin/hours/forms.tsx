'use client';

import { useState } from 'react';
import { Badge, Button, Field, Input, Toggle } from '@/components/ui';
import type { WeeklySchedule } from '@/db/schema/config';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { addHoliday, deleteHoliday, saveBusinessHours } from '../settings-actions';

type Schedule = {
  id: string;
  name: string;
  timezone: string;
  schedule: WeeklySchedule;
  isDefault: boolean;
};

type Holiday = { id: string; date: string; name: string };

const DAYS: { key: keyof WeeklySchedule; label: string }[] = [
  { key: 'sun', label: 'Sunday' },
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
];

function Fields({ schedule }: { schedule?: Schedule }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input name="name" defaultValue={schedule?.name} required placeholder="Cairo office" />
        </Field>
        <Field label="Timezone" hint="An IANA name, e.g. Africa/Cairo.">
          <Input name="timezone" defaultValue={schedule?.timezone ?? 'Africa/Cairo'} required />
        </Field>
      </div>

      <div className="flex flex-col gap-2">
        {DAYS.map((day) => {
          const range = schedule?.schedule?.[day.key]?.[0];
          return (
            <div key={day.key} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-24 text-[var(--muted-foreground)]">{day.label}</span>
              <input
                type="time"
                name={`${day.key}_start`}
                defaultValue={range?.start ?? ''}
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
              />
              <span className="text-xs text-[var(--muted-foreground)]">to</span>
              <input
                type="time"
                name={`${day.key}_end`}
                defaultValue={range?.end ?? ''}
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
              />
              <label className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                <input
                  type="checkbox"
                  name={`${day.key}_closed`}
                  defaultChecked={
                    schedule
                      ? (schedule.schedule?.[day.key]?.length ?? 0) === 0
                      : day.key === 'fri' || day.key === 'sat'
                  }
                  className="accent-brand-600"
                />
                Closed
              </label>
            </div>
          );
        })}
      </div>

      <Toggle
        name="isDefault"
        label="Use this schedule by default"
        hint="The company schedule: every group that has not been put on its own works these hours, and reporting measures against it."
        defaultChecked={schedule?.isDefault ?? false}
      />
    </>
  );
}

export function NewSchedule() {
  return (
    <Disclosure label="New schedule">
      {(close) => (
        <EditorForm action={saveBusinessHours} submitLabel="Create schedule" onSaved={close}>
          <Fields />
        </EditorForm>
      )}
    </Disclosure>
  );
}

export function HoursEditor({
  schedule,
  groupNames,
}: {
  schedule: Schedule;
  groupNames: string[];
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditorForm action={saveBusinessHours} submitLabel="Save" onSaved={() => setEditing(false)}>
        <input type="hidden" name="id" value={schedule.id} />
        <Fields schedule={schedule} />
      </EditorForm>
    );
  }

  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {schedule.name}
          {schedule.isDefault ? <Badge tone="brand">default</Badge> : null}
          <span className="text-xs font-normal text-[var(--muted-foreground)]">
            {schedule.timezone}
          </span>
        </h2>
        <p className="mt-1 text-xs text-[var(--muted-foreground)]">
          {groupNames.length
            ? `Groups on this schedule: ${groupNames.join(', ')}`
            : schedule.isDefault
              ? 'Every group that has not been put on its own schedule.'
              : 'No group is on this schedule yet, so it only applies where an SLA policy names it.'}
        </p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
          {DAYS.map((day) => {
            const range = schedule.schedule?.[day.key]?.[0];
            return (
              <div key={day.key} className="contents">
                <dt className="text-[var(--muted-foreground)]">{day.label}</dt>
                <dd>{range ? `${range.start} – ${range.end}` : 'Closed'}</dd>
              </div>
            );
          })}
        </dl>
      </div>
      <Button variant="secondary" size="sm" className="ms-auto" onClick={() => setEditing(true)}>
        Edit
      </Button>
    </div>
  );
}

export function HolidayList({ scheduleId, holidays }: { scheduleId: string; holidays: Holiday[] }) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="mt-4 border-t border-[var(--border)] pt-3">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-[var(--muted-foreground)]">
          Holidays ({holidays.length})
        </h3>
        <button
          type="button"
          onClick={() => setAdding(!adding)}
          className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-300"
        >
          {adding ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {adding ? (
        <div className="mt-2">
          <EditorForm
            action={addHoliday}
            submitLabel="Add holiday"
            onSaved={() => setAdding(false)}
          >
            <input type="hidden" name="businessHoursId" value={scheduleId} />
            <div className="grid gap-2 sm:grid-cols-2">
              <Input name="date" type="date" required />
              <Input name="name" placeholder="Eid al-Fitr" required />
            </div>
          </EditorForm>
        </div>
      ) : null}

      {holidays.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-2">
          {holidays.map((holiday) => (
            <li
              key={holiday.id}
              className="flex items-center gap-2 rounded-md bg-[var(--muted)] px-2 py-1 text-xs"
            >
              <span className="font-medium">{holiday.date}</span>
              <span className="text-[var(--muted-foreground)]">{holiday.name}</span>
              <DangerAction
                action={deleteHoliday}
                id={holiday.id}
                label="×"
                confirmLabel="Remove"
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
