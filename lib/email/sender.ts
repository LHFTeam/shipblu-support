import { isEmailAddress } from '@/lib/auth/normalise';
import { env } from '@/lib/env';

/**
 * `EMAIL_FROM_ADDRESS`, checked where mail is sent from it rather than where
 * the environment is read.
 *
 * `env()` parses the whole schema on every page, action and job, so a format
 * rule there turns one mistyped variable into a web service, a worker and
 * crons that all fail to start (`docs/PROJECT-STATE.md` §2). Here the same
 * mistake fails the sends that need it, each with a sentence naming the
 * variable, and nothing else. The question asked is the one every recipient is
 * asked (`isEmailAddress`, §6.117): a sender the provider would refuse is
 * refused before it is handed one.
 */
export function senderAddress(): string {
  const address = env().EMAIL_FROM_ADDRESS;
  if (!address) throw new Error('EMAIL_FROM_ADDRESS is not configured');
  if (!isEmailAddress(address)) {
    throw new Error('EMAIL_FROM_ADDRESS is not an email address the provider takes');
  }
  return address;
}
