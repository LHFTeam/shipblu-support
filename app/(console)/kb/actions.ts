'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticleVersions, kbArticles, kbCategories, kbFolders } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { ROLES_BY_SENIORITY, type AgentRole } from '@/lib/auth/permissions';
import { htmlToText, preview, sanitiseArticleHtml } from '@/lib/html/sanitize';
import { getArticleForEdit, takenSlugs } from '@/lib/kb/admin';
import { folderFloor, meetsFloor } from '@/lib/kb/floors';
import { normaliseArticleHtml } from '@/lib/kb/format';
import { isLocale } from '@/lib/kb/locale';
import { slugify, uniqueSlug } from '@/lib/kb/slug';

export type KbState = { error: string | null; ok?: boolean; nonce?: number };

function ok(): KbState {
  return { error: null, ok: true, nonce: Date.now() };
}

const VISIBILITIES = ['public', 'logged_in', 'agents_only', 'selected_companies'] as const;

/**
 * The role floor a form field may carry: one of the roles, or nothing at all.
 *
 * Parsed rather than cast, and empty means null rather than `'agent'`, so
 * clearing the control clears the column instead of writing a floor nobody
 * chose.
 */
function parseMinRole(value: FormDataEntryValue | null): AgentRole | null | 'invalid' {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return ROLES_BY_SENIORITY.includes(raw as AgentRole) ? (raw as AgentRole) : 'invalid';
}

/**
 * Refuses to act on an article the signed-in agent may not read.
 *
 * Every action below is reached with an id out of a `FormData` field, and
 * `kb.edit` is supervisor and up — which is exactly the population an
 * admins-only runbook is kept from. Without this, a supervisor could publish,
 * restore, retitle or delete an article they cannot open, and `saveArticle`
 * could be used to read one back by lowering its floor. `getArticleForEdit`
 * applies the same predicate the pages do, so there is one rule rather than
 * two.
 */
async function readable(id: string, role: AgentRole): Promise<boolean> {
  return (await getArticleForEdit(id, role)) !== null;
}

/**
 * Creates or updates an article.
 *
 * Body HTML is sanitised here, on the way in, so the stored row is safe for
 * every consumer rather than only for the page that happens to render it. The
 * public site renders it with `dangerouslySetInnerHTML` and does no sanitising
 * of its own — deliberately, because re-sanitising on read would mask a gap
 * here.
 */
export async function saveArticle(_state: KbState, formData: FormData): Promise<KbState> {
  const agent = await requirePermission('kb.edit');

  const id = String(formData.get('id') ?? '');
  const title = String(formData.get('title') ?? '').trim();
  const folderId = String(formData.get('folderId') ?? '');
  const locale = String(formData.get('locale') ?? 'en');
  const rawBody = String(formData.get('bodyHtml') ?? '');
  const visibility = String(formData.get('visibility') ?? 'public');
  const minRole = parseMinRole(formData.get('minRole'));
  const requestedSlug = String(formData.get('slug') ?? '').trim();
  const seoTitle = String(formData.get('seoTitle') ?? '').trim();
  const seoDescription = String(formData.get('seoDescription') ?? '').trim();
  const tags = String(formData.get('tags') ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

  if (!title) return { error: 'Give the article a title' };
  if (!folderId) return { error: 'Choose a folder' };
  if (!isLocale(locale)) return { error: 'Unknown locale' };
  if (!VISIBILITIES.includes(visibility as (typeof VISIBILITIES)[number])) {
    return { error: 'Unknown visibility' };
  }
  if (minRole === 'invalid') return { error: 'Unknown minimum role' };
  if (id && !(await readable(id, agent.role))) return { error: 'Article not found' };

  // Sanitise, then normalise, in that order: the sanitiser is the security
  // boundary and the normaliser is a formatting pass that relies on being handed
  // sanitize-html's canonical output. It runs here rather than on the editor's
  // side because an author pasting from another help desk cannot see what came
  // with the paste, and the preview beside the textarea renders their draft
  // through `.kb-article` — the same stylesheet the standard is written for.
  const bodyHtml = normaliseArticleHtml(sanitiseArticleHtml(rawBody));
  const bodyText = htmlToText(bodyHtml);
  const excerpt = preview(bodyText, 200);

  // The folder decides the category, and the category carries a locale. An
  // English article inside an Arabic category would be unreachable — the public
  // routes filter on the category's locale — so this is rejected rather than
  // silently filed somewhere nobody will find it.
  const folder = await db
    .select({
      id: kbFolders.id,
      categoryLocale: kbCategories.locale,
      visibility: kbFolders.visibility,
      minRole: kbFolders.minRole,
    })
    .from(kbFolders)
    .innerJoin(kbCategories, eq(kbCategories.id, kbFolders.categoryId))
    .where(eq(kbFolders.id, folderId))
    .limit(1);

  if (!folder[0]) return { error: 'That folder no longer exists' };
  // The picker no longer offers a folder above the caller, but the id arrives in
  // a `FormData` field — the same reason `readable()` exists above. Filing an
  // article into a folder you cannot read is a write whose result you cannot
  // see: the redirect 404s, and the article is then out of reach of every read
  // model. Answered as "no longer exists", so trying ids tells nobody anything.
  if (!meetsFloor(agent.role, folderFloor(folder[0]))) {
    return { error: 'That folder no longer exists' };
  }
  if (folder[0].categoryLocale !== locale) {
    return {
      error: `That folder belongs to a ${folder[0].categoryLocale} category, so a ${locale} article cannot live in it`,
    };
  }

  // Whether the article is internal is decided here rather than taken from the
  // form, because it is the answer that decides whether the floor column is
  // written at all — and the folder is half of it, which is the half a browser
  // can be wrong about.
  //
  // Three cases, and the third is the one that bites. The editor renders the
  // control only for an internal article, so a submission that carries no
  // `minRole` field is not somebody clearing the floor; it is a form that never
  // offered one. Writing null there would drop the floor off an article that is
  // internal through its folder — the shape all fifteen of production's
  // internal articles have — the first time anybody saved it from a stale tab
  // or with the folder list a step behind. On something a customer can open the
  // column is cleared, because the read rule ignores a floor there and a value
  // nothing reads is a value that misleads the next person to look.
  const internal = visibility === 'agents_only' || folder[0].visibility === 'agents_only';
  const floor = internal ? (formData.has('minRole') ? { minRole } : {}) : { minRole: null };

  const baseSlug = slugify(requestedSlug || title, `article-${Date.now()}`);
  const slug = uniqueSlug(baseSlug, await takenSlugs(locale, id || undefined));

  const values = {
    title,
    slug,
    folderId,
    locale,
    bodyHtml,
    bodyText,
    excerpt,
    visibility: visibility as (typeof VISIBILITIES)[number],
    ...floor,
    tags,
    seo: {
      ...(seoTitle ? { title: seoTitle } : {}),
      ...(seoDescription ? { description: seoDescription } : {}),
    },
    updatedAt: new Date(),
  };

  if (!id) {
    const inserted = await db
      .insert(kbArticles)
      .values({ ...values, status: 'draft', authorAgentId: agent.id })
      .returning({ id: kbArticles.id });

    revalidatePath('/kb');
    redirect(`/kb/${inserted[0]!.id}`);
  }

  const existing = await db
    .select({ bodyHtml: kbArticles.bodyHtml, title: kbArticles.title })
    .from(kbArticles)
    .where(eq(kbArticles.id, id))
    .limit(1);

  if (!existing[0]) return { error: 'Article not found' };

  await db.transaction(async (tx) => {
    // A version is only cut when the content actually changed. Snapshotting
    // every save would bury the edits that matter under a pile of identical
    // rows from someone tabbing through the form.
    const changed = existing[0]!.bodyHtml !== bodyHtml || existing[0]!.title !== title;

    if (changed) {
      const next = await tx
        .select({ version: sql<number>`coalesce(max(${kbArticleVersions.version}), 0) + 1` })
        .from(kbArticleVersions)
        .where(eq(kbArticleVersions.articleId, id));

      await tx.insert(kbArticleVersions).values({
        articleId: id,
        version: next[0]?.version ?? 1,
        // The version stores the state being replaced, so restoring one means
        // taking the body out of the row rather than reconstructing a diff.
        title: existing[0]!.title,
        bodyHtml: existing[0]!.bodyHtml,
        editedByAgentId: agent.id,
      });
    }

    await tx.update(kbArticles).set(values).where(eq(kbArticles.id, id));
  });

  revalidatePath('/kb');
  revalidatePath(`/kb/${id}`);
  return ok();
}

export async function setArticleStatus(_state: KbState, formData: FormData): Promise<KbState> {
  const id = String(formData.get('id') ?? '');
  const status = String(formData.get('status') ?? '');

  if (status !== 'draft' && status !== 'published' && status !== 'archived') {
    return { error: 'Unknown status' };
  }

  // Publishing is a separate permission from editing: it is the moment content
  // becomes visible to every customer, which is a different level of trust from
  // being able to draft it.
  const agent = await requirePermission(status === 'published' ? 'kb.publish' : 'kb.edit');
  if (!(await readable(id, agent.role))) return { error: 'Article not found' };

  await db
    .update(kbArticles)
    .set({
      status,
      publishedAt: status === 'published' ? new Date() : null,
      approvedByAgentId: status === 'published' ? agent.id : null,
      updatedAt: new Date(),
    })
    .where(eq(kbArticles.id, id));

  revalidatePath('/kb');
  revalidatePath(`/kb/${id}`);
  return ok();
}

export async function deleteArticle(_state: KbState, formData: FormData): Promise<KbState> {
  const agent = await requirePermission('kb.publish');

  const id = String(formData.get('id') ?? '');
  if (!(await readable(id, agent.role))) return { error: 'Article not found' };

  await db.delete(kbArticles).where(eq(kbArticles.id, id));

  revalidatePath('/kb');
  redirect('/kb');
}

export async function createCategory(_state: KbState, formData: FormData): Promise<KbState> {
  await requirePermission('kb.edit');

  const name = String(formData.get('name') ?? '').trim();
  const locale = String(formData.get('locale') ?? 'en');
  const description = String(formData.get('description') ?? '').trim() || null;

  if (!name) return { error: 'Give the category a name' };
  if (!isLocale(locale)) return { error: 'Unknown locale' };

  const existing = await db
    .select({ slug: kbCategories.slug })
    .from(kbCategories)
    .where(eq(kbCategories.locale, locale));

  const slug = uniqueSlug(
    slugify(name, `category-${Date.now()}`),
    existing.map((row) => row.slug),
  );

  await db.insert(kbCategories).values({ name, slug, locale, description });

  revalidatePath('/kb/structure');
  return ok();
}

export async function createFolder(_state: KbState, formData: FormData): Promise<KbState> {
  await requirePermission('kb.edit');

  const name = String(formData.get('name') ?? '').trim();
  const categoryId = String(formData.get('categoryId') ?? '');
  const visibility = String(formData.get('visibility') ?? 'public');
  const minRole = parseMinRole(formData.get('minRole'));

  if (!name) return { error: 'Give the folder a name' };
  if (!categoryId) return { error: 'Choose a category' };
  if (!VISIBILITIES.includes(visibility as (typeof VISIBILITIES)[number])) {
    return { error: 'Unknown visibility' };
  }
  if (minRole === 'invalid') return { error: 'Unknown minimum role' };

  const existing = await db
    .select({ slug: kbFolders.slug })
    .from(kbFolders)
    .where(eq(kbFolders.categoryId, categoryId));

  const slug = uniqueSlug(
    slugify(name, `folder-${Date.now()}`),
    existing.map((row) => row.slug),
  );

  await db.insert(kbFolders).values({
    name,
    slug,
    categoryId,
    visibility: visibility as (typeof VISIBILITIES)[number],
    // Only where the folder is internal, for the reason `lib/kb/internal.ts`
    // gives: the read rule ignores a floor on a folder a customer can open, and
    // `/kb/structure` would badge that folder with an audience nothing
    // enforces — "Admins and up" on a folder every signed-in customer can read.
    minRole: visibility === 'agents_only' ? minRole : null,
  });

  revalidatePath('/kb/structure');
  return ok();
}

/**
 * Links an article to another as its translation.
 *
 * Translations are grouped by a shared `translation_group_id` rather than by a
 * pointer from one to the other, so a third language joins the group without
 * anyone having to decide which article is the original.
 */
export async function linkTranslation(_state: KbState, formData: FormData): Promise<KbState> {
  const agent = await requirePermission('kb.edit');

  const id = String(formData.get('id') ?? '');
  const otherId = String(formData.get('otherId') ?? '');

  if (!otherId) return { error: 'Choose an article to link to' };
  if (otherId === id) return { error: 'An article cannot be its own translation' };
  // Both sides: linking is a write to one article and an assertion about the
  // other, and either being out of reach makes this somebody else's business.
  if (!(await readable(id, agent.role)) || !(await readable(otherId, agent.role))) {
    return { error: 'Article not found' };
  }

  const rows = await db
    .select({ id: kbArticles.id, locale: kbArticles.locale, group: kbArticles.translationGroupId })
    .from(kbArticles)
    .where(sql`${kbArticles.id} in (${id}, ${otherId})`);

  if (rows.length !== 2) return { error: 'Article not found' };
  if (rows[0]!.locale === rows[1]!.locale) {
    return { error: 'Both articles are in the same language' };
  }

  const target = rows.find((row) => row.id === otherId)!.group;
  await db.update(kbArticles).set({ translationGroupId: target }).where(eq(kbArticles.id, id));

  revalidatePath(`/kb/${id}`);
  return ok();
}

/** Restores a previous body, cutting a version for the state being replaced. */
export async function restoreVersion(_state: KbState, formData: FormData): Promise<KbState> {
  const agent = await requirePermission('kb.edit');

  const id = String(formData.get('id') ?? '');
  const versionId = String(formData.get('versionId') ?? '');
  if (!(await readable(id, agent.role))) return { error: 'Article not found' };

  const versions = await db
    .select({ title: kbArticleVersions.title, bodyHtml: kbArticleVersions.bodyHtml })
    .from(kbArticleVersions)
    .where(and(eq(kbArticleVersions.id, versionId), eq(kbArticleVersions.articleId, id)))
    .limit(1);

  const version = versions[0];
  if (!version) return { error: 'That version no longer exists' };

  const current = await db
    .select({ title: kbArticles.title, bodyHtml: kbArticles.bodyHtml })
    .from(kbArticles)
    .where(eq(kbArticles.id, id))
    .limit(1);

  if (!current[0]) return { error: 'Article not found' };

  await db.transaction(async (tx) => {
    const next = await tx
      .select({ version: sql<number>`coalesce(max(${kbArticleVersions.version}), 0) + 1` })
      .from(kbArticleVersions)
      .where(eq(kbArticleVersions.articleId, id));

    await tx.insert(kbArticleVersions).values({
      articleId: id,
      version: next[0]?.version ?? 1,
      title: current[0]!.title,
      bodyHtml: current[0]!.bodyHtml,
      editedByAgentId: agent.id,
    });

    // Re-sanitised and re-normalised on the way back in: an old version was
    // sanitised by whatever rules were in force when it was written, and those
    // may since have tightened — and a version cut before the formatting
    // standard existed still carries the classes and inline styles it took to
    // restore one and undo the cleanup.
    const bodyHtml = normaliseArticleHtml(sanitiseArticleHtml(version.bodyHtml));

    await tx
      .update(kbArticles)
      .set({
        title: version.title,
        bodyHtml,
        bodyText: htmlToText(bodyHtml),
        updatedAt: new Date(),
      })
      .where(eq(kbArticles.id, id));
  });

  revalidatePath(`/kb/${id}`);
  return ok();
}
