/**
 * The origin customers actually see.
 *
 * Sitemap and canonical URLs must use the help-centre hostname, not the Render
 * service URL — a sitemap advertising shipblu-support.onrender.com would get
 * that hostname indexed instead, and split the site's search ranking across two
 * domains.
 */
export function publicBaseUrl(): string {
  const host = process.env.KB_PUBLIC_HOST;
  if (host) return `https://${host.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;

  // Local development and any deployment where the custom domain is not set up
  // yet. Falling back keeps the pages working; only the absolute URLs are off.
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}
