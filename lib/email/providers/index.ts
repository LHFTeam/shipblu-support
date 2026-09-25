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
      cached = new PostmarkEmailProvider(e.EMAIL_API_KEY, e.EMAIL_WEBHOOK_SECRET, {
        // The web service sets NODE_ENV=production in `render.yaml`, and
        // `next dev` never does — the line between a deploy that lost its
        // secret and a laptop that never had one.
        requireWebhookSecret: e.NODE_ENV === 'production',
      });
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
      cached = new LocalEmailProvider();
      break;
  }

  return cached;
}

export { LocalEmailProvider, PostmarkEmailProvider };
