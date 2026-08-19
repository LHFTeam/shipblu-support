import Link from 'next/link';
import { DEFAULT_LOCALE } from '@/lib/kb/locale';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-xl font-semibold">ShipBlu Support</h1>
        </div>
        {children}
        {/* The domain's front door is the help centre now, so this page is no
            longer somewhere you arrive on purpose — it is somewhere you land
            when a console link needed a session. A way back out matters. */}
        <p className="mt-6 text-center text-sm">
          <Link
            href={`/${DEFAULT_LOCALE}`}
            className="text-[var(--muted-foreground)] underline underline-offset-4"
          >
            Help centre
          </Link>
        </p>
      </div>
    </main>
  );
}
