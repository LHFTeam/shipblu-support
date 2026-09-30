import { stripTashkeel } from '@/lib/kb/seed';
import { stripInvisible } from '@/lib/shipments/format';

/**
 * What a paste brings along that the stored text does not have.
 *
 * A name copied out of an RTL WhatsApp message carries a U+200F, which `trim()`
 * keeps because it is a format character rather than whitespace, and it made
 * the query match nobody. Tatweel and tashkeel are decoration a writer may or
 * may not use; the columns are searched as stored, and they are stored without
 * them far more often than with, so a query keeping one misses the plain
 * spelling of the same word.
 *
 * A search decides whether it has a query on this answer, not on its input: a
 * query that is only a U+200F, a tatweel or a fatha cleans to '', and `%%`
 * matches every row that has any text at all.
 */
export function cleanQuery(query: string): string {
  return stripTashkeel(stripInvisible(query)).trim();
}
