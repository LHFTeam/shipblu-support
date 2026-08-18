'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { type Locale, t } from '@/lib/kb/locale';

export function SearchBox({ locale, initial = '' }: { locale: Locale; initial?: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const query = value.trim();
        // Submitting an empty box should not navigate to an empty results page.
        if (query) router.push(`/${locale}/search?q=${encodeURIComponent(query)}`);
      }}
      role="search"
    >
      <input
        type="search"
        name="q"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={t(locale, 'searchPlaceholder')}
        aria-label={t(locale, 'search')}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
      />
    </form>
  );
}
