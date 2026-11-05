/**
 * Where a title's accent goes: the design draws one word of a topic's title in
 * the brand blue — "ShipBlu **Partners**", "Shipments & **tracking**".
 *
 * The word that names the topic, which is the last one in English and the first
 * one in Arabic. An Arabic title is a construct with its head first — شركاء شيب
 * بلو, "partners of ShipBlu" — so the last word there is the end of the brand
 * name, and colouring it painted half of "شيب بلو" blue and none of the word the
 * page is about. Taking the first word puts the accent on شركاء, عملاء, خدمات,
 * the same words the English accents.
 *
 * The front page's "How can we help?" is not a topic title, and the design
 * accents its last word in both languages, so it asks for `'last'` itself.
 *
 * A one-word title gets no accent: colouring all of it would make the whole
 * heading the accent, which is not what the design does.
 *
 * Pure and client-safe so it can be tested apart from the component.
 */
export type AccentSplit =
  { accent: 'first'; word: string; rest: string } | { accent: 'last'; rest: string; word: string };

export function accentSplit(text: string, at: 'first' | 'last'): AccentSplit | null {
  const trimmed = text.trim();

  if (at === 'first') {
    const match = /^(\S+)\s+(\S[\s\S]*)$/u.exec(trimmed);
    if (!match) return null;
    return { accent: 'first', word: match[1]!, rest: match[2]! };
  }

  const cut = trimmed.search(/\s\S+$/u);
  if (cut < 0) return null;
  return { accent: 'last', rest: trimmed.slice(0, cut).trimEnd(), word: trimmed.slice(cut + 1) };
}
