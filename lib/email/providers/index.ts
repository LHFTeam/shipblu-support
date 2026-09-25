import { env } from '@/lib/env';
import type { EmailProvider } from '../types';
import { LocalEmailProvider } from './local';
import { PostmarkEmailProvider } from './postmark';

/**
 * Resolves the configured driver. This function is the entire cost of changing
 * email vendor — nothing else in the codebase imports a provider directly.
 */

let cached: EmailProvider | null = null;

export function emailProvider(): EmailProvider {
  if (cached) return cached;

  const e = env();

  switch (e.EMAIL_PROVIDER) {
    case 'postmark': {
      if (!e.EMAIL_API_KEY) {
        throw new Error('EMAIL_PROVIDER=postmark requires EMAIL_API_KEY');
      }
      cached = new PostmarkEmailProvider(e.EMAIL_API_KEY, e.EMAIL_WEBHOOK_SECRET);
      break;
    }
    case 'mailgun': {
      // Deliberately unimplemented rather than silently falling back to `local`,
      // which would look like it was sending while writing to disk.
      throw new Error(
        'EMAIL_PROVIDER=mailgun is not implemented yet. Add lib/email/providers/mailgun.ts.',
      );
    }
    case 'local':
    default:
      cached = new LocalEmailProvider({
        // Every web service in `render.yaml` sets NODE_ENV=production, and
        // `next dev` never does — the line between an endpoint anyone can post
        // to and one on a laptop. `local` is also the schema default, so a
        // deploy that lost EMAIL_PROVIDER lands here and must not take a
        // forged post for a customer's email either.
        acceptInbound: e.NODE_ENV !== 'production',
      });
      break;
  }

  return cached;
}

export { LocalEmailProvider, PostmarkEmailProvider };
