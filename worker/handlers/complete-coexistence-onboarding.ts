import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { completeOnboarding } from '@/lib/whatsapp/onboarding-complete';
import { subjectGone } from './subject-gone';

/**
 * The second phase of connecting a WhatsApp Business-app number: everything
 * after Meta's sign-in code was exchanged and the credential stored. The steps
 * and what each records are `lib/whatsapp/onboarding-complete.ts`.
 *
 *   npm run job -- complete_coexistence_onboarding onboardingId=<uuid> [steps=history]
 *
 * The attempt row is written before this is enqueued, so a missing one is gone
 * for good, not "not yet".
 */
export async function completeCoexistenceOnboarding(job: ClaimedJob): Promise<void> {
  const { onboardingId, steps } = parseJobPayload(job, 'complete_coexistence_onboarding');
  const outcome = await completeOnboarding(onboardingId, { only: steps, job });
  if (outcome === 'gone') {
    throw subjectGone('complete_coexistence_onboarding', `onboarding ${onboardingId}`);
  }
}
