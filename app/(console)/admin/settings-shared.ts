import { revalidatePath } from 'next/cache';
import type { ActionState } from '@/lib/http/action-state';

/**
 * What the admin settings actions share, in a plain module because they are
 * not actions: a `'use server'` file may export only async functions, each of
 * them a public endpoint, so neither a helper nor a constant can live in one
 * and be imported by another.
 */

export type SettingsState = ActionState;

export function refresh(path: string) {
  revalidatePath(path);
}

/**
 * What a save answers when the row it names cannot exist. Every admin settings
 * save and delete takes the row's `id` from the form, and passing it straight to a query
 * turned a malformed one into a 22P02 thrown out of the action — a blank crash
 * where the form promises a sentence. An empty id on a save still means "create".
 */
export const GONE = 'That no longer exists — reload the page and try again';
