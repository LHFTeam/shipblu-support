import { env } from '@/lib/env';
import type { EmailProvider } from '../types';
import { LocalEmailProvider } from './local';
import { PostmarkEmailProvider } from './postmark';
import { SesEmailProvider } from './ses';

/**
 * Resolves the configured driver. This function is the entire cost of changing
 * email vendor — nothing else in the codebase imports a provider directly.
 */

let cached: EmailProvider | null = null;

export function emailProvider(): EmailProvider {
  if (cached) return cached;

  const e = env();

  switch (e.EMAIL_PROVIDER) {
    case 'ses': {
      if (!e.AWS_REGION) throw new Error('EMAIL_PROVIDER=ses requires AWS_REGION');
      cached = new SesEmailProvider({
        region: e.AWS_REGION,
        accessKeyId: e.AWS_ACCESS_KEY_ID,
        secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
        configurationSet: e.SES_CONFIGURATION_SET,
      });
      break;
    }
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
      cached = new LocalEmailProvider();
      break;
  }

  return cached;
}

/** Tests swap drivers between cases. */
export function resetEmailProviderCache(): void {
  cached = null;
}

export { LocalEmailProvider, PostmarkEmailProvider, SesEmailProvider };
