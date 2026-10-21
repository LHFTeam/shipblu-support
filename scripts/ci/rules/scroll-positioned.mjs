import ts from 'typescript';
import { fail, lineOfNode, parseSource, requireAtLeast, scannable } from '../lib.mjs';

/**
 * A scroll container is positioned (§6.81).
 *
 * `sr-only` is `position: absolute`, and an absolutely positioned box belongs
 * to its nearest positioned ancestor, not to the box it is written inside. When
 * nothing between it and `<html>` is positioned it is placed against the
 * document at its static position, which `overflow-hidden` and
 * `overflow-y-auto` both fail to clip: they clip only what they contain, and a
 * box whose containing block is above them is not contained. The console shell
 * is one screen tall and every pane scrolls inside it, so the span sits
 * however far down its pane's content it was written and stretches the
 * document to reach it. Scrolling past the end of the pane then chains to the
 * window and takes the header, the rail and the pane off the screen together.
 *
 * It has happened twice. The ticket timeline was caught in review and made
 * `relative`, and §6.81 wrote the general rule down as a sentence. The admin
 * pane never got it, and an onboarding card's step states scrolled
 * /admin/channels off an admin's screen; reproduced, that was 1,641px of
 * document under a 907px window. So it is a check: every class list that
 * makes a box scroll vertically also positions it. `relative` changes nothing
 * else about a pane — every deliberate `absolute` in one already has a
 * positioned parent nearer than the pane — so it is the cheap answer.
 *
 * Positioning the shell once instead looks like the general fix and is not.
 * The document stops growing, but the box is still placed outside the pane
 * that owns it, in the shell's own overflow: in the same reproduction the
 * shell kept 734px of scroll range nobody can wheel, and `scrollIntoView` on
 * the span scrolled the shell by all of it, header included. Inside a
 * positioned pane the span is placed in that pane's own content, where it adds
 * no scroll range at all.
 *
 * What it reads is the class list as written: the string literals and template
 * text of one `className`, or one string anywhere else (a constant of classes).
 * A position utility supplied from a variable defined elsewhere is not seen and
 * is refused; spell `relative` beside `overflow-y-auto` instead. Only the
 * unprefixed utility counts — `md:relative` leaves the box unpositioned on a
 * phone, where the console is read. Horizontal scrollers are out of scope: a
 * box escaping one lands inside the vertical pane around it, which this rule
 * has already positioned.
 */
export function checkScrollContainersArePositioned() {
  const rule = 'scroll-positioned';

  let containers = 0;
  for (const file of scannable.filter((f) => f.endsWith('.tsx') && !/\.test\.tsx$/.test(f))) {
    const source = parseSource(file);
    const seen = new Set();

    const visit = (node) => {
      if (isClassText(node) && tokens(node.text).some(scrollsVertically)) {
        const scope = classListOf(node);
        if (!seen.has(scope)) {
          seen.add(scope);
          containers++;
          if (!classTexts(scope).flatMap(tokens).some(positions)) {
            fail(
              rule,
              `${file}:${lineOfNode(source, node)}`,
              'a scroll container that is not positioned — an `sr-only` or other absolutely positioned box inside it is placed against the document instead, lengthens the page, and scrolling past the end takes the whole console off the screen; add `relative` beside it (§6.81)',
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // A rule that passes by finding nothing needs to know it looked. Today's
  // tree has 31 vertical scroll containers.
  requireAtLeast(rule, '*.tsx', containers, 15, 'vertical scroll containers in class lists');
}

const SCROLLS = new Set([
  'overflow-auto',
  'overflow-y-auto',
  'overflow-scroll',
  'overflow-y-scroll',
]);
const POSITIONED = new Set(['relative', 'absolute', 'fixed', 'sticky']);

/** Tailwind's `!` suffix marks importance, not a different utility. */
const bare = (token) => token.replace(/!$/, '');

/** With any variant: `md:overflow-y-auto` still scrolls from `md` up. */
const scrollsVertically = (token) => SCROLLS.has(bare(token.slice(token.lastIndexOf(':') + 1)));

/** Without one: a variant leaves the box unpositioned below it. */
const positions = (token) => POSITIONED.has(bare(token));

const tokens = (text) => text.split(/\s+/).filter(Boolean);

function isClassText(node) {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

/**
 * The class list a piece of text belongs to: the whole `className` it is part
 * of — so `relative` in one branch of a template counts for the
 * `overflow-y-auto` in another — or, outside JSX, the outermost template it
 * sits in, or the string itself.
 */
function classListOf(node) {
  let template = null;
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isJsxAttribute(at)) return at.initializer ?? node;
    if (ts.isTemplateExpression(at)) template = at;
    if (ts.isBlock(at) || ts.isSourceFile(at)) break;
  }
  return template ?? node;
}

/** Every piece of literal text under `scope`, read from the tree so a comment is never one. */
function classTexts(scope) {
  const texts = [];
  const collect = (node) => {
    if (isClassText(node)) texts.push(node.text);
    ts.forEachChild(node, collect);
  };
  collect(scope);
  return texts;
}
