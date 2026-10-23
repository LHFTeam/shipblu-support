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

    /**
     * And the same number again, for the copy `proxy.ts` forces.
     *
     * `serverActions.bodySizeLimit` alone is not enough: middleware runs on
     * every route here, so Next clones the request body first, and that clone is
     * capped separately at 10 MB. Going over does not fail — `body-streams.ts`
     * truncates the stream and writes a `console.warn` nobody reads — so three
     * 4 MB photos arrived as a corrupt multipart body and the submission failed
     * with nothing the customer could act on.
     *
     * Bytes, not a string: this one is compared numerically against the default
     * of 10485760.
     */
    proxyClientMaxBodySize: 27 * 1024 * 1024,
  },

  // Support tickets contain customer PII; never leak details through error pages.
  poweredByHeader: false,

  /**
   * Keep `next dev` from writing into AGENTS.md.
   *
   * When it detects an AI coding agent — which is how most work on this repo is
   * done — Next 16.3 appends a managed "agent rules" block to AGENTS.md on
   * every start, and the block instructs the agent to commit it. AGENTS.md is
   * this repo's curated instructions, and CLAUDE.md and the Copilot file are
   * symlinks to it, so every session that ran the dev server was left with a
   * dirty tree whose easiest resolution was committing text nobody here wrote.
   * The block points at the version-matched docs in
   * `node_modules/next/dist/docs/`; if that pointer is wanted, it belongs in
   * AGENTS.md in the team's own words.
   */
  agentRules: false,

  /**
   * The topic taxonomy's pages moved when it became the subcategory (Stage 2.A
   * of `plans/ticket-category-routing.md`), and a bookmark or a link pasted in
   * a chat still names the old paths.
   *
   * Temporary, a 307, never a 308: Stage 3 puts the new category field's admin
   * page at `/admin/categories`, and a permanent redirect is cached by every
   * browser that followed it, so admins would keep landing on subcategories
   * after the path means something else. For the same reason each source is
   * exact rather than `/admin/categories/:path*`: redirects run before the
   * filesystem, so a wildcard would hide Stage 3's whole tree. An exact source
   * hides one page the same way, and Stage 3's tree may grow a `review` or a
   * `shadow` of its own, so the PR that adds its page deletes all three
   * `/admin/categories` entries; `/reports/categories` goes in whichever PR
   * first puts a report there. The query string carries over on its own
   * (`?days=`, `?run=`).
   */
  async redirects() {
    return [
      { source: '/admin/categories', destination: '/admin/subcategories', permanent: false },
      {
        source: '/admin/categories/review',
        destination: '/admin/subcategories/review',
        permanent: false,
      },
      {
        source: '/admin/categories/shadow',
        destination: '/admin/subcategories/shadow',
        permanent: false,
      },
      { source: '/reports/categories', destination: '/reports/subcategories', permanent: false },
    ];
  },

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
