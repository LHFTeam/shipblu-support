import Link from 'next/link';
import { ShipBluLogo } from '@/components/brand';
import { Card } from '@/components/ui';
import { DEFAULT_LOCALE } from '@/lib/kb/locale';

/**
 * Sign-in, first-run setup and invite activation share one card, with the
 * brand inside it rather than above, so the page reads as one object on the
 * canvas instead of a heading floating over a box.
 */

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-(--color-background-canvas) px-4 py-12">
      <div className="w-full max-w-[360px]">
        <Card padded={false} className="flex flex-col gap-3.5 p-6">
          <div className="flex items-center gap-2.5">
            <ShipBluLogo className="size-9" />
            <div>
              <h1 className="text-base font-semibold">ShipBlu Support</h1>
              <p className="text-xs text-(--color-text-secondary)">Agent console</p>
            </div>
          </div>
          {children}
        </Card>
        {/* The domain's front door is the help centre now, so this page is no
            longer somewhere you arrive on purpose — it is somewhere you land
            when a console link needed a session. A way back out matters. */}
        <p className="mt-6 text-center text-sm">
          <Link
            href={`/${DEFAULT_LOCALE}`}
            className="text-(--color-text-link) underline-offset-4 hover:text-(--color-text-link-hover) hover:underline"
          >
            Help centre
          </Link>
        </p>
      </div>
    </main>
  );
}
