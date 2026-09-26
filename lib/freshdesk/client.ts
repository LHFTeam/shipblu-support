import { env } from '@/lib/env';

/**
 * Freshdesk Solutions API client.
 *
 * Read-only and used once, by the importer, so it covers exactly the three
 * endpoints the knowledge base needs. Authentication is HTTP Basic with the API
 * key as the username and any non-empty password, which is Freshdesk's
 * documented scheme.
 */

export class FreshdeskError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly isTransient: boolean,
  ) {
    super(message);
    this.name = 'FreshdeskError';
  }
}

export type FreshdeskCategory = {
  id: number;
  name: string;
  description?: string | null;
  /** Present on translated categories. */
  language_id?: number;
};

export type FreshdeskFolder = {
  id: number;
  category_id: number;
  name: string;
  description?: string | null;
  /** 1 = all, 2 = logged-in users, 3 = agents, 4 = selected companies. */
  visibility?: number;
};

export type FreshdeskArticle = {
  id: number;
  folder_id: number;
  title: string;
  description?: string | null;
  description_text?: string | null;
  /** 1 = draft, 2 = published. */
  status?: number;
  seo_data?: { meta_title?: string; meta_description?: string; meta_keywords?: string[] };
  tags?: string[];
  hits?: number;
  thumbs_up?: number;
  thumbs_down?: number;
  updated_at?: string;
};

function credentials() {
  const e = env();
  if (!e.FRESHDESK_DOMAIN) throw new Error('FRESHDESK_DOMAIN is not configured');
  if (!e.FRESHDESK_API_KEY) throw new Error('FRESHDESK_API_KEY is not configured');

  const domain = e.FRESHDESK_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');

  return {
    base: `https://${domain}/api/v2`,
    // The password half is ignored by Freshdesk but must be present.
    auth: `Basic ${Buffer.from(`${e.FRESHDESK_API_KEY}:X`).toString('base64')}`,
  };
}

/** A slow page of articles is seconds; anything past this is not coming back. */
const TIMEOUT_MS = 15_000;

/**
 * One GET, with a deadline.
 *
 * The deadline is what keeps the rest of the queue moving. The importer runs as
 * a job, and the worker awaits its whole batch before it claims another — so a
 * request that never answered stopped every queued job, sends and syncs
 * included, until the process restarted. A timeout is a transient failure like
 * a 5xx: the queue's backoff retries the import.
 */
async function request(path: string): Promise<Response> {
  const { base, auth } = credentials();

  try {
    return await fetch(`${base}${path}`, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new FreshdeskError(
        `Freshdesk ${path} did not answer in ${TIMEOUT_MS / 1000}s`,
        0,
        true,
      );
    }
    throw error;
  }
}

/** Returns null on 404 instead of throwing, for endpoints that may not exist. */
async function getOptional<T>(path: string): Promise<T | null> {
  const response = await request(path);

  // 404 is the normal answer for "this item has no translation in that
  // language", so it is a result rather than a failure.
  if (response.status === 404) return null;

  if (!response.ok) {
    const text = await response.text();
    throw new FreshdeskError(
      `Freshdesk ${path} failed (${response.status}): ${text.slice(0, 300)}`,
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }

  return (await response.json()) as T;
}

async function get<T>(path: string): Promise<T> {
  const response = await request(path);

  if (!response.ok) {
    const text = await response.text();

    // 429 carries Retry-After and is the one Freshdesk returns most: the
    // Solutions API is rate limited per minute and a full KB is hundreds of
    // requests.
    throw new FreshdeskError(
      `Freshdesk ${path} failed (${response.status}): ${text.slice(0, 300)}`,
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }

  return (await response.json()) as T;
}

/**
 * Freshdesk paginates with `page` and `per_page`, and signals the end by
 * returning fewer than a full page — there is no total count and no cursor.
 * Bounded so a paging bug cannot turn an import into an unbounded crawl.
 */
async function getAll<T>(path: string, perPage = 100): Promise<T[]> {
  const collected: T[] = [];

  for (let page = 1; page <= 100; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const batch = await get<T[]>(`${path}${separator}page=${page}&per_page=${perPage}`);

    collected.push(...batch);
    if (batch.length < perPage) break;
  }

  return collected;
}

export async function listCategories(): Promise<FreshdeskCategory[]> {
  return getAll<FreshdeskCategory>('/solutions/categories');
}

export async function listFolders(categoryId: number): Promise<FreshdeskFolder[]> {
  return getAll<FreshdeskFolder>(`/solutions/categories/${categoryId}/folders`);
}

export async function listArticles(folderId: number): Promise<FreshdeskArticle[]> {
  return getAll<FreshdeskArticle>(`/solutions/folders/${folderId}/articles`);
}

/**
 * Freshdesk's visibility integers, mapped onto ours.
 *
 * Anything unrecognised becomes `agents_only` rather than `public`. A new
 * visibility level we have not seen must not default to publishing content on
 * the internet.
 */
export function mapVisibility(
  visibility: number | undefined,
): 'public' | 'logged_in' | 'agents_only' | 'selected_companies' {
  switch (visibility) {
    case 1:
      return 'public';
    case 2:
      return 'logged_in';
    case 4:
      return 'selected_companies';
    case 3:
    default:
      return 'agents_only';
  }
}

/** 2 is published in Freshdesk; everything else is a draft. */
export function mapStatus(status: number | undefined): 'draft' | 'published' {
  return status === 2 ? 'published' : 'draft';
}

// --- Translations -----------------------------------------------------------
//
// Freshdesk serves a translated item by appending a language code to the item's
// own URL. There is deliberately no "list articles in language X" endpoint —
// the client library that documents this API has list methods only for the
// primary language — so translations are fetched one item at a time, by id.

export async function getTranslatedCategory(
  id: number,
  code: string,
): Promise<FreshdeskCategory | null> {
  return getOptional<FreshdeskCategory>(`/solutions/categories/${id}/${code}`);
}

export async function getTranslatedFolder(
  id: number,
  code: string,
): Promise<FreshdeskFolder | null> {
  return getOptional<FreshdeskFolder>(`/solutions/folders/${id}/${code}`);
}

export async function getTranslatedArticle(
  id: number,
  code: string,
): Promise<FreshdeskArticle | null> {
  return getOptional<FreshdeskArticle>(`/solutions/articles/${id}/${code}`);
}

/**
 * Language codes to try for each of our locales.
 *
 * Freshdesk accounts are configured with either a short code or a regional one,
 * and there is no endpoint that lists which. Trying the short form first
 * matches the common case; the regional forms are the fallback. Freshdesk
 * writes regional codes with a dash, not an underscore.
 */
export const LANGUAGE_CODE_CANDIDATES: Record<string, string[]> = {
  en: ['en', 'en-US', 'en-GB'],
  ar: ['ar', 'ar-SA', 'ar-EG'],
};

/** Ids to try when working out which code an account uses for a language. */
export type LanguageProbe = { categoryIds: number[]; articleIds: number[] };

/**
 * Finds the code this account actually uses for a locale, by asking for real
 * items in each candidate until one answers.
 *
 * Done once per run rather than guessed per request: a wrong code returns 404
 * for every item, which is indistinguishable from "nothing is translated" and
 * would make the import quietly find nothing.
 *
 * Several ids are probed, not one, and articles as well as categories. Probing
 * a single category was a real bug: ShipBlu's first category is an internal
 * staff guide that nobody had translated, so `en` 404'd there, was never
 * discovered, and every English article in the account was skipped while the
 * import reported success. One untranslated item must not be able to hide a
 * whole language — and because a category can be left untranslated while the
 * articles beneath it are not, the articles have to be askable too.
 */
export async function discoverLanguageCode(
  locale: string,
  probe: LanguageProbe,
): Promise<string | null> {
  for (const code of LANGUAGE_CODE_CANDIDATES[locale] ?? [locale]) {
    for (const id of probe.categoryIds) {
      if (await getTranslatedCategory(id, code)) return code;
    }
    for (const id of probe.articleIds) {
      if (await getTranslatedArticle(id, code)) return code;
    }
  }
  return null;
}
