/**
 * WhatsApp template handling: reading Meta's component definitions, and
 * building the component payload a send requires.
 *
 * Templates are the only way to message a customer outside the 24-hour window,
 * and Meta rejects a send whose parameter count does not exactly match the
 * approved body — so the console needs to know how many variables a template
 * takes *before* the agent hits send. That is what `templateVariables` is for.
 */

export type MetaComponent = {
  type?: string;
  format?: string;
  text?: string;
  example?: Record<string, unknown>;
  buttons?: { type?: string; text?: string; url?: string }[];
};

export type TemplateParameter =
  | { type: 'text'; text: string }
  | { type: 'currency'; currency: { fallback_value: string; code: string; amount_1000: number } }
  | { type: 'date_time'; date_time: { fallback_value: string } }
  | { type: 'image'; image: { link: string } }
  | { type: 'document'; document: { link: string; filename?: string } }
  | { type: 'video'; video: { link: string } };

export type WhatsAppTemplateComponent = {
  type: 'header' | 'body' | 'button';
  sub_type?: 'quick_reply' | 'url';
  index?: string;
  parameters: TemplateParameter[];
};

export type TemplateShape = {
  /** Body text with {{1}} placeholders, for previewing in the composer. */
  bodyText: string | null;
  headerText: string | null;
  headerFormat: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION' | null;
  footerText: string | null;
  /** Highest placeholder index in the body, i.e. how many values are required. */
  bodyVariableCount: number;
  headerVariableCount: number;
  buttons: { type: string; text: string }[];
};

/**
 * Meta numbers placeholders from 1 and they need not appear in order, so the
 * count is the maximum index — not the number of matches. A body reading
 * "{{2}} then {{1}}" takes two parameters; counting matches happens to agree
 * here but disagrees the moment a template repeats a variable.
 */
export function countVariables(text: string | null | undefined): number {
  if (!text) return 0;
  let max = 0;
  for (const match of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    const index = Number(match[1]);
    if (Number.isFinite(index) && index > max) max = index;
  }
  return max;
}

export function templateShape(components: unknown[]): TemplateShape {
  const list = (components ?? []) as MetaComponent[];

  const header = list.find((c) => c.type?.toUpperCase() === 'HEADER');
  const body = list.find((c) => c.type?.toUpperCase() === 'BODY');
  const footer = list.find((c) => c.type?.toUpperCase() === 'FOOTER');
  const buttons = list.find((c) => c.type?.toUpperCase() === 'BUTTONS');

  const headerFormat = (header?.format?.toUpperCase() ?? null) as TemplateShape['headerFormat'];

  return {
    bodyText: body?.text ?? null,
    headerText: headerFormat === 'TEXT' ? (header?.text ?? null) : null,
    headerFormat,
    footerText: footer?.text ?? null,
    bodyVariableCount: countVariables(body?.text),
    headerVariableCount: headerFormat === 'TEXT' ? countVariables(header?.text) : 0,
    buttons: (buttons?.buttons ?? []).map((b) => ({
      type: b.type ?? 'QUICK_REPLY',
      text: b.text ?? '',
    })),
  };
}

/** Substitutes {{n}} so the console can show what the customer will receive. */
export function renderTemplatePreview(text: string | null, values: string[]): string {
  if (!text) return '';
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (match, index: string) => {
    const value = values[Number(index) - 1];
    return value !== undefined && value !== '' ? value : match;
  });
}

export type BuildComponentsInput = {
  shape: TemplateShape;
  bodyValues: string[];
  headerValues?: string[];
  /** Public URL for a media header (image/video/document templates). */
  headerMediaUrl?: string | null;
  headerMediaFilename?: string | null;
};

export class TemplateParameterError extends Error {}

/**
 * Builds Meta's `components` array, validating counts first.
 *
 * Validating locally rather than letting Meta reject the send matters because a
 * rejected template send still counts against the business's quality rating,
 * and the agent gets a useful message instead of error code 132000.
 */
export function buildTemplateComponents(input: BuildComponentsInput): WhatsAppTemplateComponent[] {
  const { shape, bodyValues, headerValues = [] } = input;
  const components: WhatsAppTemplateComponent[] = [];

  if (bodyValues.length !== shape.bodyVariableCount) {
    throw new TemplateParameterError(
      `Template needs ${shape.bodyVariableCount} body value(s), got ${bodyValues.length}`,
    );
  }
  if (bodyValues.some((value) => value.trim() === '')) {
    // Meta rejects empty strings, and a blank in a template reads as a bug to
    // the customer regardless.
    throw new TemplateParameterError('Template values cannot be blank');
  }

  if (shape.headerFormat === 'TEXT' && shape.headerVariableCount > 0) {
    if (headerValues.length !== shape.headerVariableCount) {
      throw new TemplateParameterError(
        `Template header needs ${shape.headerVariableCount} value(s), got ${headerValues.length}`,
      );
    }
    components.push({
      type: 'header',
      parameters: headerValues.map((text) => ({ type: 'text', text })),
    });
  }

  if (shape.headerFormat && shape.headerFormat !== 'TEXT' && shape.headerFormat !== 'LOCATION') {
    if (!input.headerMediaUrl) {
      throw new TemplateParameterError(
        `Template header is ${shape.headerFormat} and needs a media URL`,
      );
    }
    const url = input.headerMediaUrl;
    const parameter: TemplateParameter =
      shape.headerFormat === 'IMAGE'
        ? { type: 'image', image: { link: url } }
        : shape.headerFormat === 'VIDEO'
          ? { type: 'video', video: { link: url } }
          : {
              type: 'document',
              document: {
                link: url,
                ...(input.headerMediaFilename ? { filename: input.headerMediaFilename } : {}),
              },
            };
    components.push({ type: 'header', parameters: [parameter] });
  }

  if (shape.bodyVariableCount > 0) {
    components.push({
      type: 'body',
      parameters: bodyValues.map((text) => ({ type: 'text', text })),
    });
  }

  return components;
}
