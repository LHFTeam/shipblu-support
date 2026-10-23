import ts from 'typescript';
import { fail, lineOfNode, parseSource, read, requireAtLeast, scannableSource } from '../lib.mjs';

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
 * no scroll range — unless a clipping box between the two hides where it sits,
 * which is why a component that renders inside one positions itself as well.
 * Nor is positioning `.app-scroll` in globals.css, though most panes carry it
 * (§6.81): it is declared only under `@media (pointer: fine)`, so a phone
 * would never get it, and unlayered, so it would beat the `fixed` on the
 * admin mobile nav, which carries it too. Moved into a layer, it would still
 * leave this rule to find every scroll and read its branches and `static`s,
 * and would save only the word `relative`.
 *
 * What it reads is the class list as written, in any `.ts` or `.tsx` module:
 * the literals and template text of one `className`, or of one expression of
 * classes anywhere else. A position counts only where it applies whenever the
 * scroll does — in the same text, anywhere in the template, `+` or `+=` around
 * it, or in both arms of a `?:` — and never behind `&&`, `||`, `??` or a call,
 * any of which can leave it out. It must be unprefixed or carry exactly the
 * scroll's own variant: `md:relative` beside a bare `overflow-y-auto` leaves
 * the box scrolling unpositioned on a phone, where the console is read, while
 * beside `md:overflow-y-auto` it covers every size the box scrolls at. A
 * different variant is refused even where it would cover the scroll (an `lg:`
 * scroll, an `md:` position); spell the same one. A `static` anywhere in the
 * list is refused, under any variant or condition, because it can take the
 * position back — on a `?:` arm that never scrolls too, and inside a
 * `className` in a call's argument, since this cannot tell those from
 * `cn(…, open && 'md:static')`, so a branch like that goes in a list of its
 * own. Importance is read either way round (`!relative`, `relative!`), and an
 * arbitrary property as the utility it spells (`[overflow-y:auto]`,
 * `[position:relative]`). A position written against an interpolation, a call
 * or another operand, with no space between, is not one: `${base}relative`
 * renders as a single class that positions nothing, so spell the space in the
 * text itself. A piece that can render nothing, an empty `?:` arm among them,
 * is looked past to whatever is beyond it. Nor can it tell a sentence from a
 * class list: a message naming `overflow-y-auto` as a bare word is read as
 * one, so name a utility in backticks there, as prose here already does.
 *
 * What it does not see: a position supplied through a variable or a helper
 * (spell `relative` beside `overflow-y-auto` instead); outside a `className`, a
 * `static` in another argument of the call, each argument there being a list of
 * its own; a call that does not render its arguments the way `cn` does, spaced
 * and where the call stands — one that glues them (`.concat()`, `.join('')`) or
 * trims them (`twMerge`) — or one reached through an array, an object, `await`
 * or a method on its result (`cn([…])`, `'…'.trim()`), where the climb stops; a
 * variant that moves a utility onto other elements (`*:`, `[&>li]:`), read as
 * if it were the box's own; a box made to scroll by an inline `style` or a
 * stylesheet rule, of which the console has none — globals.css scrolls only
 * horizontally; an arbitrary `overflow` with two values or a variable
 * (`[overflow:hidden_auto]`), where `overflow-y-auto` says the same; an axis
 * utility narrowing a shorthand, so `overflow-auto overflow-y-hidden` is read
 * as a vertical scroller (spell a horizontal one `overflow-x-auto`); an
 * `sr-only` under a clipping box between it and its pane, usually in another
 * file, which is why a component mounted inside one positions itself, as
 * `AttachmentList` does; and horizontal scrollers, out of scope because a box
 * escaping one lands inside the vertical pane around it, which this rule has
 * already positioned.
 */
export function checkScrollContainersArePositioned() {
  const rule = 'scroll-positioned';

  let containers = 0;
  for (const file of scannableSource.filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))) {
    // Every utility this looks for spells `overflow`, so a module without the
    // word has no container to find and is not parsed — which keeps reading
    // every `.ts` module in `lib/` from costing the run anything.
    if (!read(file).includes('overflow')) continue;

    const source = parseSource(file);
    const seen = new Set();
    const refused = new Set();

    const visit = (node) => {
      const scrolls = isClassText(node) ? tokens(node.text).filter(scrollsVertically) : [];
      if (scrolls.length > 0) {
        const list = classListOf(node);
        if (!seen.has(list)) {
          seen.add(list);
          containers++;
        }
        const problem = refused.has(list) ? null : unpositioned(node, scrolls, list);
        if (problem) {
          refused.add(list);
          fail(rule, `${file}:${lineOfNode(source, node)}`, MESSAGES[problem]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // A rule that passes by finding nothing needs to know it looked. Today's
  // tree has 31 vertical scroll containers.
  requireAtLeast(rule, '*.ts, *.tsx', containers, 15, 'vertical scroll containers in class lists');
}

const CONSEQUENCE =
  'an `sr-only` or other absolutely positioned box inside it is placed against the document instead, lengthens the page, and scrolling past the end takes the whole console off the screen';

const MESSAGES = {
  unpositioned: `a scroll container that is not positioned wherever it scrolls — ${CONSEQUENCE}; add \`relative\` beside it, unprefixed, outside any condition and with a space between it and any interpolation or operand it touches (§6.81)`,
  static: `a scroll container that a \`static\` unpositions again — ${CONSEQUENCE}; drop the \`static\`, or move the branch that carries it into a list of its own (§6.81)`,
};

/**
 * Why `text`, which makes its box scroll with `scrolls`, leaves the box
 * unpositioned, or null when it does not.
 */
function unpositioned(text, scrolls, list) {
  if (classTexts(list).flatMap(tokens).some(unpositions)) return 'static';
  const covered = scrolls.every((scroll) => carriedWherever(text, list, positionsWhile(scroll)));
  return covered ? null : 'unpositioned';
}

/**
 * Whether a token `accepts` is in the class list every time `text` is: some
 * expression `text` is part of, up to the whole list, carries one however it
 * is evaluated. Whenever `text` is in the output so is every expression it
 * sits in, so anything one of them always carries comes with it.
 */
function carriedWherever(text, list, accepts) {
  for (let at = text; at; at = at.parent) {
    if (alwaysCarries(at, accepts)) return true;
    if (at === list) return false;
  }
  return false;
}

/**
 * Whether `node`'s value holds a token `accepts` however it is evaluated: a
 * whole token of its own text (`wholeTokens`), any piece of a template, a `+`
 * or a `+=`, both arms of a `?:`. Never `&&`, `||` or `??`, whose value can be
 * the operand without it, nor a call, which may return anything.
 */
function alwaysCarries(node, accepts) {
  if (isClassText(node)) return wholeTokens(node).some(accepts);
  const parts = piecesOf(node);
  if (parts) return parts.some((part) => alwaysCarries(part, accepts));
  // `carriedWherever` climbs through a span, which `piecesOf` flattens away.
  if (ts.isTemplateSpan(node)) {
    return alwaysCarries(node.expression, accepts) || alwaysCarries(node.literal, accepts);
  }
  if (isWrapper(node)) return Boolean(node.expression) && alwaysCarries(node.expression, accepts);
  if (ts.isConditionalExpression(node)) {
    return alwaysCarries(node.whenTrue, accepts) && alwaysCarries(node.whenFalse, accepts);
  }
  return false;
}

const SCROLLS = new Set([
  'overflow-auto',
  'overflow-y-auto',
  'overflow-scroll',
  'overflow-y-scroll',
]);
const POSITIONED = new Set(['relative', 'absolute', 'fixed', 'sticky']);

/**
 * A token's variants and the utility they apply. Variants end at the last `:`
 * outside brackets, because an arbitrary variant (`[&:lang(ar)]:`) and an
 * arbitrary property (`[overflow-y:auto]`) carry colons of their own.
 * Importance is not a different utility: Tailwind 4 writes it last and still
 * reads it first (`relative!`, `!relative`, `md:!relative`). An arbitrary
 * property is read as the utility it spells.
 */
function parseToken(token) {
  let depth = 0;
  let cut = 0;
  for (let at = 0; at < token.length; at++) {
    const c = token[at];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) cut = at + 1;
  }
  const utility = token
    .slice(cut)
    .replace(/^!|!$/g, '')
    .replace(/^\[(overflow(?:-y)?|position):([a-z]+)\]$/, (_, property, value) =>
      property === 'position' ? value : `${property}-${value}`,
    );
  return { variant: token.slice(0, cut), utility };
}

/** With any variant: `md:overflow-y-auto` still scrolls from `md` up. */
const scrollsVertically = (token) => SCROLLS.has(parseToken(token).utility);

/**
 * Positioned wherever `scroll` scrolls: unprefixed, or under exactly its
 * variant. Any other variant can leave it scrolling unpositioned somewhere.
 */
const positionsWhile = (scroll) => {
  const { variant } = parseToken(scroll);
  return (token) => {
    const parsed = parseToken(token);
    return POSITIONED.has(parsed.utility) && (parsed.variant === '' || parsed.variant === variant);
  };
};

/**
 * Under any variant: a variant's rule is emitted after every bare utility, so
 * `md:static` takes the position back from `md` up, and a bare `static` sorts
 * after `relative`, so beside it it wins everywhere.
 */
const unpositions = (token) => parseToken(token).utility === 'static';

const tokens = (text) => text.split(/\s+/).filter(Boolean);

/**
 * The tokens of `text` that are whole classes every time it renders. One at
 * an edge counts only when whitespace parts it from whatever the list puts
 * beside it: `${base}relative` renders as `p-2relative`, which positions
 * nothing. Only a position is read this way. A scroll touching an
 * interpolation is still a scroll, because `overflow-y-auto${extra}` scrolls
 * whenever `extra` is empty, and a `static` is still refused wherever it sits.
 *
 * Kept per node: `carriedWherever` asks every text of a list at each level it
 * climbs, for every scroll in it, and the answer depends only on the tree.
 */
function wholeTokens(text) {
  let words = wholeTokensOf.get(text);
  if (!words) {
    words = tokens(text.text);
    if (!parted(text, 'start')) words.shift();
    if (!parted(text, 'end')) words.pop();
    wholeTokensOf.set(text, words);
  }
  return words;
}

const wholeTokensOf = new WeakMap();

/**
 * Whether whitespace, or the edge of its class list, is at `edge` of `text`
 * every time it renders. Outward from `text`, a template, a `+` or a `+=` puts
 * its neighbouring pieces there, and where those can render nothing the
 * question moves on past them, so an empty `?:` arm is looked through rather
 * than read as glue. A `?:` arm, a `&&`, `||` or `??` operand or a wrapper
 * shares the edge of the expression around it, and so does a call's argument
 * or a tagged template's text, because whatever the call returns sits where
 * the call does: `p-2${cn('relative')}` glues as `${base}relative` does. An
 * argument with another beside it that always renders a class is parted by
 * the space `cn` and its kin put between them, so only an outermost one meets
 * the call's neighbours. Anything else is where the list ends.
 */
function parted(text, edge) {
  if ((edge === 'start' ? /^\s/ : /\s$/).test(text.text)) return true;
  for (let at = text; ;) {
    const parent = at.parent;
    const whole = parent && ts.isTemplateSpan(parent) ? parent.parent : parent;
    const parts = whole && piecesOf(whole);
    if (parts) {
      const i = parts.indexOf(at);
      const beside = edge === 'start' ? parts.slice(0, i).reverse() : parts.slice(i + 1);
      const next = edgeOfPieces(beside, edge === 'start' ? 'end' : 'start');
      if (next.glue) return false;
      if (!next.empty) return true;
      at = whole;
    } else if (parent && isClassExpression(parent)) {
      at = parent;
    } else if (parent && isCallOf(parent, at)) {
      if (ts.isCallExpression(parent)) {
        const i = parent.arguments.indexOf(at);
        const beside =
          edge === 'start' ? parent.arguments.slice(0, i) : parent.arguments.slice(i + 1);
        if (beside.some(rendersClass)) return true;
      }
      at = parent;
    } else {
      return true;
    }
  }
}

/**
 * What the renders of `node` may put at `edge`, as far as the text shows:
 * `empty` when some render is nothing at all, and `glue` when some render
 * may end in anything but whitespace there — which is all a variable, a call
 * or a `&&` can promise. Neither means every render has whitespace there.
 */
function edgeOf(node, edge) {
  if (isClassText(node)) {
    if (node.text === '') return { empty: true, glue: false };
    return { empty: false, glue: !(edge === 'start' ? /^\s/ : /\s$/).test(node.text) };
  }
  const parts = piecesOf(node);
  if (parts) return edgeOfPieces(edge === 'start' ? parts : [...parts].reverse(), edge);
  if (isWrapper(node) && node.expression) return edgeOf(node.expression, edge);
  if (ts.isConditionalExpression(node)) {
    const a = edgeOf(node.whenTrue, edge);
    const b = edgeOf(node.whenFalse, edge);
    return { empty: a.empty || b.empty, glue: a.glue || b.glue };
  }
  return { empty: false, glue: true };
}

/**
 * `edgeOf` for pieces rendered one after another, the one at `edge` first:
 * each piece's edge, and the next piece's wherever that one renders nothing.
 */
function edgeOfPieces(pieces, edge) {
  const out = { empty: true, glue: false };
  for (const piece of pieces) {
    const at = edgeOf(piece, edge);
    out.glue ||= at.glue;
    if (!at.empty) {
      out.empty = false;
      break;
    }
  }
  return out;
}

/** Whether every render of `node` holds a class: some text that is not whitespace. */
function rendersClass(node) {
  if (isClassText(node)) return /\S/.test(node.text);
  const parts = piecesOf(node);
  if (parts) return parts.some(rendersClass);
  if (isWrapper(node)) return Boolean(node.expression) && rendersClass(node.expression);
  if (ts.isConditionalExpression(node)) {
    return rendersClass(node.whenTrue) && rendersClass(node.whenFalse);
  }
  return false;
}

/**
 * Whether `node` is what `call` renders around: one of its arguments, or a
 * tagged template's text.
 */
function isCallOf(call, node) {
  return (
    (ts.isCallExpression(call) && call.arguments.includes(node)) ||
    (ts.isTaggedTemplateExpression(call) && call.template === node)
  );
}

/**
 * The pieces a template, a `+` or a `+=` renders one after another, in order.
 * A `+=` appends to whatever its left side already holds, so it glues exactly
 * as a `+` does, rather than sharing an edge the way a `&&` operand does.
 */
function piecesOf(node) {
  if (ts.isTemplateExpression(node)) {
    return [node.head, ...node.templateSpans.flatMap((span) => [span.expression, span.literal])];
  }
  if (isConcatenation(node) || isAppend(node)) return [node.left, node.right];
  return null;
}

function isClassText(node) {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

/** Expressions whose value is their operand's: parentheses, a JSX `{…}`, and type assertions. */
function isWrapper(node) {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isJsxExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  );
}

function isConcatenation(node) {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

function isAppend(node) {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken;
}

/**
 * The class list a piece of text belongs to, counted and reported once: the
 * whole `className` it is part of, whatever sits inside it, or outside JSX
 * the outermost expression of templates, `+`, `?:`, `&&` and their kin around
 * it. That one stops at a call, whose arguments are its own business.
 */
function classListOf(node) {
  for (let at = node.parent; at && !ts.isBlock(at) && !ts.isSourceFile(at); at = at.parent) {
    if (ts.isJsxAttribute(at)) return at.initializer ?? node;
  }
  let list = node;
  while (list.parent && isClassExpression(list.parent)) list = list.parent;
  return list;
}

function isClassExpression(node) {
  return (
    ts.isTemplateExpression(node) ||
    ts.isTemplateSpan(node) ||
    ts.isConditionalExpression(node) ||
    ts.isBinaryExpression(node) ||
    isWrapper(node)
  );
}

/** Every piece of literal text under `list`, read from the tree so a comment is never one. */
function classTexts(list) {
  const texts = [];
  const collect = (node) => {
    if (isClassText(node)) texts.push(node.text);
    ts.forEachChild(node, collect);
  };
  collect(list);
  return texts;
}
