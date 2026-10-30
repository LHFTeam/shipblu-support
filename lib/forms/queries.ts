import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import type { Priority } from '@/lib/tickets/vocabulary';
import { ticketForms } from '@/db/schema';
import type { TicketFieldDef } from '@/lib/tickets/custom-fields';
import { listTicketFields } from '@/lib/tickets/lookups';
import { parseFormElements, type FormElement } from './elements';
import { formName } from './naming';

export { formConfirmation, formDescription, formName } from './naming';

/**
 * Reading forms out of the database.
 *
 * Every read parses `elements` through `parseFormElements` against the fields
 * that currently exist, so a form is never handed to a renderer or to the
 * submit path in a shape either of them has to re-validate. That is also why the
 * field definitions travel with the form: the two are read together on every
 * screen that uses either, and letting a caller fetch them separately is how a
 * form gets rendered against one set of definitions and submitted against
 * another.
 */

export type FormRecord = {
  id: string;
  slug: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  elements: FormElement[];
  requiresSignIn: boolean;
  showOnHelpCentre: boolean;
  showInConsole: boolean;
  defaultGroupId: string | null;
  /** Read once, as the ticket is created — see `ticket_forms.default_category_id`. */
  defaultCategoryId: string | null;
  defaultPriority: Priority | null;
  defaultType: string | null;
  defaultTags: string[];
  subjectTemplate: string | null;
  confirmationAr: string;
  confirmationEn: string;
  position: number;
  isActive: boolean;
};

/** A form and the field definitions its elements were parsed against. */
export type LoadedForm = { form: FormRecord; fields: TicketFieldDef[] };

/** What a picker needs, without parsing every form's layout to draw a list. */
export type FormSummary = {
  id: string;
  slug: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  requiresSignIn: boolean;
};

export async function listForms(surface: 'help_centre' | 'console'): Promise<FormSummary[]> {
  return db
    .select({
      id: ticketForms.id,
      slug: ticketForms.slug,
      nameAr: ticketForms.nameAr,
      nameEn: ticketForms.nameEn,
      descriptionAr: ticketForms.descriptionAr,
      descriptionEn: ticketForms.descriptionEn,
      requiresSignIn: ticketForms.requiresSignIn,
    })
    .from(ticketForms)
    .where(
      and(
        eq(ticketForms.isActive, true),
        surface === 'help_centre'
          ? eq(ticketForms.showOnHelpCentre, true)
          : eq(ticketForms.showInConsole, true),
      ),
    )
    .orderBy(asc(ticketForms.position), asc(ticketForms.slug));
}

async function load(row: typeof ticketForms.$inferSelect | undefined): Promise<LoadedForm | null> {
  if (!row) return null;

  const fields = await listTicketFields();

  return {
    form: { ...row, elements: parseFormElements(row.elements, fields) },
    fields,
  };
}

/**
 * Inactive forms are **not** excluded here.
 *
 * The pages decide: the help centre refuses one, and the admin screen has to be
 * able to open the form it just deactivated. Filtering here would make "preview
 * before publishing" impossible without a second query that forgot the parse.
 */
export async function getFormBySlug(slug: string): Promise<LoadedForm | null> {
  const rows = await db.select().from(ticketForms).where(eq(ticketForms.slug, slug)).limit(1);
  return load(rows[0]);
}

/**
 * The forms that place a given custom field, so deleting one can say what it
 * would break.
 *
 * Scanned in JavaScript rather than with a jsonb containment predicate, and the
 * reason is not squeamishness about SQL: `ticket_forms` is a configuration table
 * with tens of rows, Vitest runs without a database so a `@>` against a jsonb
 * array is a statement no test here can execute, and doing it in code means the
 * answer comes from the same parser the renderer uses. A form that names a field
 * inside an element the parser rejects still counts — the admin meant to place
 * it, and telling them "no forms use this" before silently blanking one is the
 * outcome this exists to prevent.
 */
export async function formsUsingField(key: string): Promise<string[]> {
  return (await fieldPlacements()).get(key) ?? [];
}

/**
 * Every custom field's forms at once, for the Fields page: each editor names
 * the forms that place its field beside the Active box, since switching a field
 * off makes every one of them stop asking it without a word. One read of a
 * table of tens of rows, rather than one per field.
 */
export async function fieldPlacements(): Promise<Map<string, string[]>> {
  const rows = await db
    .select({
      slug: ticketForms.slug,
      nameEn: ticketForms.nameEn,
      nameAr: ticketForms.nameAr,
      elements: ticketForms.elements,
    })
    .from(ticketForms);
  return placementsOf(rows);
}

/** The scan itself, apart from the read, so a test can hold it to its answer. */
export function placementsOf(
  rows: readonly {
    slug: string;
    nameEn: string;
    nameAr: string;
    elements: readonly unknown[];
  }[],
): Map<string, string[]> {
  const placed = new Map<string, string[]>();
  for (const row of rows) {
    const keys = new Set<string>();
    for (const element of row.elements) {
      if (element === null || typeof element !== 'object') continue;
      const { kind, key } = element as Record<string, unknown>;
      if (kind === 'field' && typeof key === 'string') keys.add(key);
    }
    for (const key of keys) placed.set(key, [...(placed.get(key) ?? []), formName(row, 'en')]);
  }
  return placed;
}
