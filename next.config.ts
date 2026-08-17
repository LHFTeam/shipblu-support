import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The worker and job runner import the same `db/` and `lib/` modules as the app.
  // Keeping these external stops Next from trying to bundle native/node-only deps.
  serverExternalPackages: ['postgres', '@node-rs/argon2'],

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
    ];
  },
};

export default nextConfig;
