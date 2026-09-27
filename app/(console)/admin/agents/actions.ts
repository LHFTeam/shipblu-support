'use server';

import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { text } from '@/lib/http/form-data';
import { validatePolicy } from '@/lib/presence/idle';
import { savePresencePolicy } from '@/lib/presence/policy';
import { refresh, type SettingsState } from '../settings-shared';

// --- Presence policy ---------------------------------------------------------

/**
 * When the console decides somebody has stopped working.
 *
 * Under `admin.agents` rather than a permission of its own: it is a rule about
 * the team, and it sits on the page that lists them.
 *
 * Blank means the timer is off, and that is the only way to turn one off — so
 * an unreadable value has to be an error rather than a silent null, which is
 * what `optionalMinutes` would give. A typo quietly disabling the
 * sign-out is exactly the failure this form must not have: nothing would look
 * wrong afterwards, because "nobody was ever signed out" and "the timeout is
 * working" look identical from the outside.
 *
 * Everything else about the numbers — whole, in range, and the sign-out no
 * shorter than the away — is `validatePolicy`'s, so the form and the tests
 * agree on the wording of each refusal.
 */
export async function savePresenceSettings(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const admin = await requirePermission('admin.agents');

  const away = minutesOrOff(formData, 'autoAwayAfterMins');
  const signout = minutesOrOff(formData, 'autoSignoutAfterMins');

  if (away === 'not_a_number' || signout === 'not_a_number') {
    return { error: 'Enter a number of minutes, or leave the box empty to turn it off.' };
  }

  const policy = { autoAwayAfterMins: away, autoSignoutAfterMins: signout };
  const problem = validatePolicy(policy);
  if (problem) return { error: problem };

  await savePresencePolicy(policy, admin.id);

  refresh('/admin/agents');
  return ok();
}

/**
 * Blank is "off", anything numeric is a window, and text is the admin's typo.
 *
 * Deliberately does *not* check that the number is whole or in range —
 * `validatePolicy` owns both, and it has the wording for each. Checking here
 * too made that function's "has to be a whole number of minutes" message
 * unreachable from the only form that writes these, which is how a tested
 * message ends up being one nobody can ever see.
 */
function minutesOrOff(formData: FormData, key: string): number | null | 'not_a_number' {
  const raw = text(formData, key);
  if (!raw) return null;

  const value = Number(raw);
  return Number.isFinite(value) ? value : 'not_a_number';
}
