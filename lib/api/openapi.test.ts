import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from './openapi';
import { ERROR_STATUS, ErrorCode } from './schemas';

/**
 * The myBlu API's contract, held to what is committed and to what it promises.
 *
 * `docs/myblu-api.openapi.json` is what the app's developers, their mock and
 * the SDK read, and `lib/api/schemas.ts` is what the routes parse with. A
 * change to one without the other is a contract that says one thing and a
 * server that does another, found by an app in the field. So the committed
 * file is compared with the builder — as parsed documents, since Prettier
 * formats the file — and then the document is read for the three promises a
 * generator would otherwise break on our behalf: no answer is a closed object,
 * every enum in an answer says that values are added, and every union whose
 * arms a field tells apart keeps an arm open on that field.
 */

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

type Json = Record<string, unknown>;

const built = JSON.parse(JSON.stringify(openApiDocument())) as Json;
const committed = JSON.parse(readFileSync(root('docs/myblu-api.openapi.json'), 'utf8')) as Json;
const guide = readFileSync(root('docs/myblu-api.md'), 'utf8');
const changelog = readFileSync(root('docs/myblu-api-changelog.md'), 'utf8');

const components = built.components as {
  schemas: Record<string, Json>;
  examples: Record<string, { value: Json }>;
};

/** What a `$ref` names, inside this document. */
function resolve(ref: string): Json {
  const parts = ref.replace(/^#\//, '').split('/');
  let node: unknown = built;
  for (const part of parts) node = (node as Json)[part];
  if (!node) throw new Error(`unresolved ${ref}`);
  return node as Json;
}

/** Every schema node reachable from `roots`, `$ref`s followed once each. */
function reachable(roots: unknown[]): { node: Json; at: string }[] {
  const seen = new Set<string>();
  const out: { node: Json; at: string }[] = [];
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${at}[${i}]`));
    if (!node || typeof node !== 'object') return;
    const json = node as Json;
    if (typeof json.$ref === 'string') {
      if (seen.has(json.$ref)) return;
      seen.add(json.$ref);
      return walk(resolve(json.$ref), json.$ref);
    }
    out.push({ node: json, at });
    for (const [key, value] of Object.entries(json)) {
      // An example is a value, not a schema: its keys are field names.
      if (key === 'examples' || key === 'example' || key === 'default') continue;
      walk(value, `${at}/${key}`);
    }
  };
  roots.forEach((rootNode, i) => walk(rootNode, `root[${i}]`));
  return out;
}

const operations = Object.entries(built.paths as Record<string, Record<string, Json>>).flatMap(
  ([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method, op })),
);

const webhookOperations = Object.values(built.webhooks as Record<string, { post: Json }>).map(
  (hook) => hook.post,
);

function contentSchemas(holder: unknown): unknown[] {
  const content = (holder as { content?: Record<string, { schema?: unknown }> })?.content ?? {};
  return Object.values(content).map((media) => media.schema);
}

/**
 * What the server answers or sends: every response's body, the webhook's
 * bodies, and any component nothing a caller sends refers to — the push
 * payload, which only the guide and the SDK name.
 */
function answerRoots(): unknown[] {
  const answers = [
    ...operations.flatMap(({ op }) => Object.values(op.responses as Json).flatMap(contentSchemas)),
    ...webhookOperations.flatMap((op) => contentSchemas(op.requestBody)),
  ];
  const sent = reachable(
    operations.flatMap(({ op }) => [...contentSchemas(op.requestBody), op.parameters ?? []]),
  );
  const fromRequests = new Set(
    sent.map(({ at }) => at).filter((at) => at.startsWith('#/components/schemas/')),
  );
  const unreferenced = Object.keys(components.schemas)
    .map((name) => `#/components/schemas/${name}`)
    .filter((ref) => !fromRequests.has(ref))
    .map((ref) => ({ $ref: ref }));
  return [...answers, ...unreferenced];
}

describe('the committed document', () => {
  it('is what lib/api/openapi.ts builds', () => {
    // On failure: run `npm run api:openapi` and commit docs/myblu-api.openapi.json,
    // with a line in docs/myblu-api-changelog.md if the contract changed.
    expect(committed).toEqual(built);
  });

  it('is versioned by the newest line of the changelog', () => {
    const newest = /^- (\d{4}-\d{2}-\d{2})\b/m.exec(changelog)?.[1];
    expect(newest).toBeDefined();
    expect((built.info as Json).version).toBe(newest);
  });
});

describe('every answer', () => {
  const nodes = reachable(answerRoots());

  it('reaches the shapes it should, so the checks below cannot pass on nothing', () => {
    const names = new Set(nodes.map(({ at }) => at));
    for (const name of [
      'Ticket',
      'Message',
      'Config',
      'ErrorBody',
      'WebhookEvent',
      'AnyWebhookEvent',
      'PushData',
      'Survey',
    ]) {
      expect(names, name).toContain(`#/components/schemas/${name}`);
    }
    expect(nodes.filter(({ node }) => Array.isArray(node.enum)).length).toBeGreaterThan(5);
  });

  it('is open to fields it does not name', () => {
    const closed = nodes
      .filter(
        ({ node }) => node.additionalProperties === false || node.unevaluatedProperties === false,
      )
      .map(({ at }) => at);
    expect(closed).toEqual([]);
  });

  /**
   * A union whose arms one field tells apart — the webhook's `type` — is a
   * closed list to a validator unless an arm takes any value there, and under
   * `oneOf` that open arm makes every known value match twice and fail. So a
   * union of `const`s in an answer is an `anyOf` with an open arm, or a new
   * event type is refused by every receiver built from the document.
   */
  it('keeps an open arm in every union a field tells apart', () => {
    const tagOf = (arm: Json, key: string) =>
      (arm.properties as Record<string, Json> | undefined)?.[key]?.const;
    const takesAny = (arm: Json, key: string) => {
      const field = (arm.properties as Record<string, Json> | undefined)?.[key];
      return !field || (!('const' in field) && !Array.isArray(field.enum));
    };

    const closed = nodes
      .filter(({ node }) => Array.isArray(node.anyOf) || Array.isArray(node.oneOf))
      .flatMap(({ node, at }) => {
        const arms = ((node.anyOf ?? node.oneOf) as Json[])
          .map((arm) => (typeof arm.$ref === 'string' ? resolve(arm.$ref) : arm))
          .filter((arm) => arm.properties !== undefined);
        const keys = new Set(arms.flatMap((arm) => Object.keys(arm.properties as Json)));
        const tags = [...keys].filter(
          (key) =>
            new Set(arms.map((arm) => tagOf(arm, key)).filter((tag) => tag !== undefined)).size > 1,
        );
        return tags.flatMap((key) => [
          ...(Array.isArray(node.oneOf) ? [`${at}: a oneOf told apart by ${key}`] : []),
          ...(arms.some((arm) => takesAny(arm, key)) ? [] : [`${at}: no arm open on ${key}`]),
        ]);
      });
    expect(closed).toEqual([]);
  });

  /**
   * A client obeys a wait or a lifetime as it comes: a `pollAfterSeconds` of 0
   * would have it poll in a tight loop, and a token or a link that lives 0
   * seconds is one it asks for again at once. Named `…Seconds`, every one.
   */
  it('gives every wait and lifetime in seconds a floor of 1', () => {
    const fields = nodes.flatMap(({ node, at }) =>
      Object.entries((node.properties as Record<string, Json> | undefined) ?? {})
        .filter(([name]) => name.endsWith('Seconds'))
        .map(([name, field]) => ({ at: `${at}.${name}`, field })),
    );
    expect(fields.length).toBeGreaterThanOrEqual(6);
    const floorless = fields
      .filter(({ field }) => field.type !== 'integer' || !((field.minimum as number) >= 1))
      .map(({ at }) => at);
    expect(floorless).toEqual([]);
  });

  it('says of every enum that values are added', () => {
    const silent = nodes
      .filter(({ node }) => Array.isArray(node.enum))
      .filter(({ node }) => !/values are added/i.test(String(node.description ?? '')))
      .map(({ at }) => at);
    expect(silent).toEqual([]);
  });
});

describe('the worked examples', () => {
  it('give every operation an example of its success', () => {
    for (const { path, method, op } of [
      ...operations,
      ...webhookOperations.map((op) => ({ path: 'webhook', method: 'post', op })),
    ]) {
      const success = Object.entries(op.responses as Record<string, Json>).filter(([status]) =>
        /^2/.test(status),
      );
      const examples = [...success.map(([, response]) => response), op.requestBody].flatMap(
        (holder) =>
          Object.values(
            (holder as { content?: Record<string, { examples?: Json }> })?.content ?? {},
          ).flatMap((media) => Object.keys(media.examples ?? {})),
      );
      // `DELETE /session` has neither a body nor an answer to show.
      if (op.operationId === 'endSession') continue;
      expect(examples.length, `${method} ${path}`).toBeGreaterThan(0);
    }
  });

  it('give every error code one, under the status it is answered with', () => {
    expect(Object.keys(components.examples).sort()).toEqual([...ErrorCode.options].sort());
    for (const code of ErrorCode.options) {
      expect(components.examples[code]?.value).toMatchObject({ error: { code } });
    }

    const used = new Set<string>();
    for (const { op } of operations) {
      for (const [status, response] of Object.entries(op.responses as Record<string, Json>)) {
        const media = (response.content as Record<string, { examples?: Json }> | undefined)?.[
          'application/json'
        ];
        for (const code of Object.keys(media?.examples ?? {})) {
          if (!(code in ERROR_STATUS)) continue;
          expect(String(ERROR_STATUS[code as ErrorCode]), `${op.operationId} ${code}`).toBe(status);
          used.add(code);
        }
      }
    }
    // Every code is answered somewhere: a code no operation gives is a promise
    // the guide makes to nobody.
    expect([...used].sort()).toEqual([...ErrorCode.options].sort());
  });
});

/**
 * The refusal lines are written for an SDK, and the server plane is myBlu's
 * backend: its bearer is `MYBLU_API_TOKEN`, with no session behind it to
 * refresh, and on `POST /sessions` its app is waiting. A backend reading the
 * client plane's lines there would refresh a token it does not have.
 */
describe('the server plane', () => {
  const server = operations.filter(({ op }) =>
    (op.security as Json[]).some((scheme) => 'serverPlane' in scheme),
  );

  it('is told nothing that is only an SDK’s to do', () => {
    expect(server.map(({ path }) => path).sort()).toEqual(['/sessions', '/sessions/revoke']);
    const told = server.flatMap(({ path, op }) =>
      Object.entries(op.responses as Record<string, Json>)
        .filter(([, response]) =>
          /refresh once|replay once|a create fails/i.test(String(response.description)),
        )
        .map(([status]) => `${path} ${status}`),
    );
    expect(told).toEqual([]);
  });

  it('is told which of the mint’s refusals reach the app as they came', () => {
    const mint = server.find(({ path }) => path === '/sessions')!.op.responses as Record<
      string,
      Json
    >;
    for (const status of ['403', '429', '503']) {
      expect(String(mint[status]?.description), status).toContain('Relayed to the app as it came');
    }
    for (const status of ['400', '401', '500']) {
      expect(String(mint[status]?.description), status).toContain('`502`');
    }
  });
});

/**
 * The guide is reviewed rather than built, so only what can drift by itself
 * is held here: the names it has to share with the document.
 */
describe('the guide', () => {
  it('names every error code and every path', () => {
    for (const code of ErrorCode.options) expect(guide, code).toContain(`\`${code}\``);
    for (const path of Object.keys(built.paths as Json)) expect(guide, path).toContain(path);
  });

  /**
   * The webhook's test vector, recomputed rather than trusted. Read out of the
   * guide, so a receiver written from the guide is checked against what the
   * guide says, and the vector cannot drift from the scheme beside it.
   */
  it("prints a webhook signature this scheme produces, over the document's example", () => {
    const block = /```text\n(secret: [\s\S]*?)```/.exec(guide)?.[1];
    expect(block, 'the test vector block').toBeDefined();
    const line = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(block ?? '')?.[1];

    const secret = line('secret');
    const timestamp = line('timestamp');
    const body = line('body');
    const signature = line('signature');
    expect([secret, timestamp, body, signature].every(Boolean)).toBe(true);

    const expected = `v1=${createHmac('sha256', secret!).update(`${timestamp}.${body}`).digest('hex')}`;
    expect(signature).toBe(expected);

    // The same delivery the document's webhook example shows.
    const hook = (built.webhooks as Json).event as { post: Json };
    const media = (hook.post.requestBody as { content: Record<string, { examples: Json }> })
      .content['application/json'];
    expect(JSON.parse(body!)).toEqual(
      (media?.examples['message.created'] as { value: Json }).value,
    );

    const parameters = (built.components as { parameters: Record<string, Json> }).parameters;
    expect(parameters.WebhookTimestamp?.example).toBe(timestamp);
    expect(parameters.WebhookSignature?.example).toBe(signature);
  });
});
