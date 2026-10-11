import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * React 19 resets a form after every function action, a refusal included
 * (§6.80). A form with a field that reset would move — the console's, the help
 * centre's or a sign-in page's — submits through `useActionForm`, spread as
 * `<form {...form}>`; a form of hidden fields, buttons and controlled text
 * boxes has nothing to lose and may keep `action=`.
 */

/** Fifteen forms with nothing a reset moves: the rule's floor. */
const FORMS = many(
  15,
  (i) => `app/(console)/area${i}/forms.tsx`,
  () =>
    'export const F = () => (\n  <form action={act}>\n    <input type="hidden" name="id" value="1" />\n    <button type="submit">Go</button>\n  </form>\n);\n',
);

/** One form whose children are `lines`, the `<form>` on line 2. */
const form = (open, ...lines) =>
  `export const F = () => (\n  ${open}\n${lines.map((l) => `    ${l}\n`).join('')}  </form>\n);\n`;

const at = (file, line, field) =>
  expect.objectContaining({
    rule: 'form-reset',
    where: `${file}:${line}`,
    message: expect.stringContaining(`<${field}>`),
  });

const run = (files) => runRule('form-reset', { ...FORMS, ...files });

describe('form-reset', () => {
  it('passes a form spread from useActionForm, whatever it holds', async () => {
    const found = await run({
      'app/(console)/inbox/reply.tsx': form(
        '<form key={key} {...form} className="flex">',
        '<Textarea name="body" />',
        '<Select name="kind" value={kind}><option /></Select>',
      ),
    });

    expect(found).toEqual([]);
  });

  it('passes a form that handles its own submit', async () => {
    const found = await run({
      'app/(console)/x.tsx': form('<form action={act} onSubmit={submit}>', '<textarea name="b" />'),
    });

    expect(found).toEqual([]);
  });

  it('passes a plain HTML form with a string action', async () => {
    const found = await run({
      'app/(console)/layout.tsx': form(
        '<form action="/api/auth/logout" method="post">',
        '<input name="q" />',
      ),
    });

    expect(found).toEqual([]);
  });

  // The purge panel: its one typed field is controlled, and a reset leaves a
  // controlled text box showing its value.
  it('passes a controlled text box', async () => {
    const found = await run({
      'app/(console)/purge-panel.tsx': form(
        '<form action={formAction}>',
        '<input type="hidden" name="id" value={id} />',
        '<input value={typed} onChange={(e) => setTyped(e.target.value)} />',
        '<Input value={other} onChange={() => {}} />',
      ),
    });

    expect(found).toEqual([]);
  });

  it('refuses an uncontrolled text field, and names the form', async () => {
    const found = await run({
      'app/(console)/notes.tsx': form(
        '<form action={action}>',
        '<Textarea name="body" required />',
      ),
    });

    expect(found).toEqual([at('app/(console)/notes.tsx', 2, 'Textarea')]);
  });

  // The template picker and the KB visibility select: controlled, and still
  // moved, because React leaves the browser no default of its own to go back to.
  it('refuses a select even when it is controlled', async () => {
    const found = await run({
      'app/(console)/kb/editor.tsx': form(
        '<form action={action}>',
        '<Select name="visibility" value={visibility} onChange={change}>',
        '  <option value="public">Public</option>',
        '</Select>',
      ),
    });

    expect(found).toEqual([at('app/(console)/kb/editor.tsx', 2, 'Select')]);
  });

  it('refuses a checkbox even when it is controlled', async () => {
    const found = await run({
      'app/(console)/inbox/reply.tsx': form(
        '<form action={action}>',
        '<input type={"checkbox"} checked={privately} value="on" onChange={toggle} />',
      ),
    });

    expect(found).toEqual([at('app/(console)/inbox/reply.tsx', 2, 'input')]);
  });

  it('finds the field however deep it sits', async () => {
    const found = await run({
      'app/(console)/admin/x.tsx': form(
        '<form action={action}>',
        '<div>',
        '  <Field label="Name">{open ? <input name="name" /> : null}</Field>',
        '</div>',
      ),
    });

    expect(found).toEqual([at('app/(console)/admin/x.tsx', 2, 'input')]);
  });

  // The help centre's search and tracking boxes: a GET to a URL built from
  // the locale, which React hands to the browser untouched.
  it('passes a plain HTML form whose action is a template', async () => {
    const found = await run({
      'app/help/[locale]/search-box.tsx': form(
        '<form action={`/${locale}/search`} role="search">',
        '<input name="q" />',
      ),
    });

    expect(found).toEqual([]);
  });

  // The portal reply box emptied a customer's reply when the ticket closed
  // while they typed, and both sign-in forms emptied the address.
  it('reads the help centre and the sign-in pages as well as the console', async () => {
    const found = await run({
      'app/help/[locale]/portal/reply.tsx': form(
        '<form action={action}>',
        '<textarea name="body" />',
      ),
      'app/(auth)/login/form.tsx': form('<form action={action}>', '<Input name="email" />'),
    });

    expect(found).toEqual([
      at('app/(auth)/login/form.tsx', 2, 'Input'),
      at('app/help/[locale]/portal/reply.tsx', 2, 'textarea'),
    ]);
  });
});
