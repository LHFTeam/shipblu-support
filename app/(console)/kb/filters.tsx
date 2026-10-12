'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Input, Select } from '@/components/ui';
import type { ArticleFilters } from '@/lib/kb/admin';

export function KbFilters({ filters }: { filters: ArticleFilters }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <div className="flex flex-wrap gap-2">
      {/* A plain Input, not a SearchInput: this box is in no form, and Enter
          is how it searches — SearchInput gives Enter to the keyboard instead. */}
      <Input
        defaultValue={filters.q}
        onKeyDown={(event) => {
          if (event.key === 'Enter') setParam('q', event.currentTarget.value.trim());
        }}
        placeholder="Search title or slug, then press Enter"
        // `sm:py-1.5` is the Select's own rule, so the box and the two selects
        // beside it are one height.
        className="min-w-56 flex-1 sm:py-1.5"
      />

      <div className="w-36">
        <Select value={filters.status} onChange={(e) => setParam('status', e.target.value)}>
          <option value="all">Any status</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </Select>
      </div>

      <div className="w-32">
        <Select value={filters.locale} onChange={(e) => setParam('locale', e.target.value)}>
          <option value="all">Any language</option>
          <option value="en">English</option>
          <option value="ar">العربية</option>
        </Select>
      </div>
    </div>
  );
}
