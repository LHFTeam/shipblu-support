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

async function get<T>(path: string): Promise<T> {
  const { base, auth } = credentials();

  const response = await fetch(`${base}${path}`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });

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
