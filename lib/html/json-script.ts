/**
 * JSON for the inside of a `<script>` element — the help centre's JSON-LD.
 *
 * `JSON.stringify` alone is not enough there. It leaves `<` as it is, and the
 * HTML parser ends a script element at the first `</script>` it meets, whatever
 * JSON is around it — so a breadcrumb label carrying the search query, as the
 * results page's does, ran as script for anybody sent a link to
 * `/search?q=</script><script>…`. React escapes text it renders; it does not and
 * cannot escape what is handed to `dangerouslySetInnerHTML`.
 *
 * `<` is the same character to every JSON reader, so the structured data
 * means exactly what it did, and with no literal `<` left nothing can close the
 * element or open a `<!--` that changes how the parser reads the rest. U+2028
 * and U+2029 are escaped as well, which keeps the output safe should it ever be
 * inlined as a JavaScript literal rather than as JSON.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
