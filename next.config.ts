import type { NextConfig } from 'next';

/**
 * Origins allowed to embed the chat widget.
 *
 * Read from the environment rather than hard-coded, because the widget goes on
 * the merchant dashboard and eventually the marketing site, and each is a
 * different origin. Empty means the widget is embeddable only from our own
 * origin, which is the safe default for a fresh deploy.
 *
 * The help centre is not one of the origins that has to be listed, even on its
 * custom domain: `/widget/embed.js` frames the hostname that served it, so the
 * iframe is always same-origin with the page and `'self'` covers it.
 */
function widgetFrameAncestors(): string {
  const configured = (process.env.WIDGET_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return ["'self'", ...configured].join(' ');
}

const nextConfig: NextConfig = {
  // The worker and job runner import the same `db/` and `lib/` modules as the app.
  // Keeping these external stops Next from trying to bundle native/node-only deps.
  serverExternalPackages: ['postgres', '@node-rs/argon2'],

  experimental: {
    serverActions: {
      /**
       * A ticket form can carry photographs of a damaged parcel.
       *
       * The default is 1 MB, and going over it fails with an error that never
       * mentions size — the submission simply does not arrive. This is set just
       * above `MAX_FORM_TOTAL_BYTES` in `lib/forms/files.ts` on purpose,
       * so the limit a customer actually meets is the one that can explain
       * itself rather than Next's own rejection.
       *
       * It is not larger than that because the body is buffered in memory before
       * any application code runs, so this number is also how much RAM a single
       * hostile request can ask an instance for.
       */
      bodySizeLimit: '26mb',
    },
  },

  // Support tickets contain customer PII; never leak details through error pages.
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        // The widget exists to be framed, so the blanket DENY above cannot
        // apply to it. It is replaced with an explicit allowlist rather than
        // dropped: `frame-ancestors` is the modern control and, unlike
        // X-Frame-Options, it takes a list of origins.
        //
        // This is the only route where framing is permitted. The console and
        // the help centre keep DENY, so neither can be put inside an attacker's
        // page and clickjacked.
        source: '/widget/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: '' },
          {
            key: 'Content-Security-Policy',
            value: `frame-ancestors ${widgetFrameAncestors()};`,
          },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
