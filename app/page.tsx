import { redirect } from 'next/navigation';
import { DEFAULT_LOCALE } from '@/lib/kb/locale';

/**
 * The front door.
 *
 * Everyone who arrives at the bare domain — customers, and agents who typed the
 * hostname rather than their bookmark — lands on the Arabic help centre. It used
 * to redirect to the agent console, which made the public site something you had
 * to already know the URL of, on a domain whose entire purpose is public support.
 *
 * `proxy.ts` rewrites the locale-prefixed path under /help, so this one redirect
 * works on the Render URL and on support.shipblu.com alike. Agents reach the
 * console from the Sign in button in the header.
 */
export default function Home() {
  redirect(`/${DEFAULT_LOCALE}`);
}
