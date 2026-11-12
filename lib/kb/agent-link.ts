/**
 * What the knowledge panel's Insert puts in a reply: the article's title, and
 * on its own line the link to send a customer, never the one the agent opens
 * (`articleLinks` in `./site.ts`). Its own module, with nothing imported, so the
 * client component that calls it carries nothing else into the browser.
 *
 * Title and URL on separate lines. Every channel we send on carries plain
 * text, so there is no anchor to hang a title on, and on its own line the
 * Latin URL cannot be reordered by the bidi algorithm when it lands in the
 * middle of an Arabic paragraph.
 */
export function insertedArticleLink(hit: { title: string; sendUrl: string }): string {
  return `${hit.title}\n${hit.sendUrl}`;
}
