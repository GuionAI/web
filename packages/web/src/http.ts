import {
  DEFAULT_LINK_LIMIT,
  DEFAULT_KEPOS_BRIDGE_ENDPOINT,
  FetchCapabilityError,
  isOperationAborted,
  isRequestTimeout,
  MAX_LINK_LIMIT,
  RENDER_REPORT_URL,
  throwIfAborted,
  validateKeposBridgeEndpoint,
  type KeposBridgeResponse,
  type SearchResponse,
  type WebCredentials,
  type WebOperations,
} from "@guionai/web-core";
import * as webCoreModule from "@guionai/web-core";
import { HTTPException } from "hono/http-exception";
import {
  createRoute,
  OpenAPIHono,
  z,
  type RouteConfig,
} from "@hono/zod-openapi";

import { credentialsFromEnvironment } from "./runtime.js";

const DEFAULT_SOURCE_COUNT = 10;
const DEFAULT_SOURCE_CONTEXT = 10;
const DEFAULT_SOURCE_TIMEOUT = 0;

/** Dependencies and server-local configuration for the personal HTTP service. */
export type HttpServiceDependencies = {
  operations?: WebOperations;
  credentials?: WebCredentials | (() => WebCredentials);
  keposBridgeEndpoint?: string;
  /** Injectable environment for startup/configuration tests. */
  environment?: NodeJS.ProcessEnv;
  /** Used by build-time OpenAPI generation to skip runtime credential checks. */
  validateStartup?: boolean;
};

export type HttpServiceState = {
  operations: WebOperations;
  credentials: WebCredentials;
  keposBridgeEndpoint: string;
};

export type HttpError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

const ErrorSchema = z
  .object({
    code: z.string().openapi({ example: "upstream_error" }),
    message: z.string().openapi({ example: "search failed" }),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .openapi("HttpError");

const SearchResultSchema = z
  .object({
    title: z.string(),
    link: z.string(),
    snippet: z.string(),
    position: z.number().int(),
  })
  .strict()
  .openapi("SearchResult");

const SearchResponseSchema = z
  .object({
    provider: z.enum(["Exa", "Brave", "Kepos Bridge"]),
    results: z.array(SearchResultSchema),
  })
  .strict()
  .openapi("SearchResponse");

const FetchResponseSchema = z
  .object({
    url: z.string(),
    mode: z.enum(["full", "tree", "section"]),
    content: z.string(),
  })
  .strict()
  .openapi("FetchResponse");

const LinkSchema = z
  .object({ text: z.string(), url: z.string() })
  .strict()
  .openapi("PageLink");

const LinksResponseSchema = z
  .object({
    url: z.string(),
    links: z.array(LinkSchema),
    truncated: z.boolean(),
  })
  .strict()
  .openapi("LinksResponse");

const DocsLibrarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    trust_score: z.number(),
    total_snippets: z.number().int(),
    versions: z.array(z.string()).optional(),
  })
  .strict()
  .openapi("DocsLibrary");

const DocsResolveResponseSchema = z
  .object({ query: z.string(), libraries: z.array(DocsLibrarySchema) })
  .strict()
  .openapi("DocsResolveResponse");

const DocsFetchResponseSchema = z
  .object({
    library_id: z.string(),
    topic: z.string().optional(),
    content: z.string(),
  })
  .strict()
  .openapi("DocsFetchResponse");

const SourceSearchResponseSchema = z
  .object({ content: z.string() })
  .strict()
  .openapi("SourceSearchResponse");

const KeposResponseSchema = z
  .object({ output: z.string(), results: z.array(z.unknown()).optional() })
  .strict()
  .openapi("KeposResponse");

const SearchRequestSchema = z
  .object({ query: z.string().min(1) })
  .strict()
  .openapi("SearchRequest");

const HttpUrlSchema = z
  .string()
  .min(1)
  .refine(isHttpURL, "url must be an absolute HTTP(S) URL");

const FetchRequestSchema = z
  .object({
    url: HttpUrlSchema,
    tree: z.boolean().default(false),
    section_id: z.string().optional(),
    full: z.boolean().default(false),
    tree_threshold: z.number().int().default(5000),
    render: z.enum(["fetch", "agent-browser"]).default("fetch"),
    waitMs: z.number().int().min(0).max(30_000).optional(),
  })
  .strict()
  .openapi("FetchRequest");

const LinksRequestSchema = z
  .object({
    url: HttpUrlSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LINK_LIMIT)
      .default(DEFAULT_LINK_LIMIT),
    render: z.enum(["fetch", "agent-browser"]).default("fetch"),
    waitMs: z.number().int().min(0).max(30_000).optional(),
  })
  .strict()
  .openapi("LinksRequest");

const DocsResolveRequestSchema = z
  .object({ query: z.string().min(1) })
  .strict()
  .openapi("DocsResolveRequest");

const DocsFetchRequestSchema = z
  .object({
    library_id: z.string().min(1),
    topic: z.string().optional(),
    tokens: z.number().int().min(0).default(0),
  })
  .strict()
  .openapi("DocsFetchRequest");

const SourceSearchRequestSchema = z
  .object({
    query: z.string().min(1),
    count: z.number().int().default(DEFAULT_SOURCE_COUNT),
    context: z.number().int().default(DEFAULT_SOURCE_CONTEXT),
    timeout: z.number().int().min(0).default(DEFAULT_SOURCE_TIMEOUT),
  })
  .strict()
  .openapi("SourceSearchRequest");

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must be a non-blank string");

const WeatherRequestSchema = z
  .object({
    location: NonBlankStringSchema,
    start: DateSchema.optional(),
    duration: z.number().int().positive().safe().optional(),
  })
  .strict()
  .openapi("WeatherRequest");

const SportsRequestSchema = z
  .object({
    fn: z.enum(["schedule", "standings"]),
    league: z.enum([
      "nba",
      "wnba",
      "nfl",
      "nhl",
      "mlb",
      "epl",
      "ncaamb",
      "ncaawb",
      "ipl",
    ]),
    team: NonBlankStringSchema.optional(),
    opponent: NonBlankStringSchema.optional(),
    date_from: DateSchema.optional(),
    date_to: DateSchema.optional(),
    num_games: z.number().int().positive().safe().optional(),
    locale: NonBlankStringSchema.optional(),
  })
  .strict()
  .openapi("SportsRequest");

const FinanceRequestSchema = z
  .object({
    ticker: NonBlankStringSchema,
    type: z.enum(["equity", "fund", "crypto", "index"]),
    market: NonBlankStringSchema.optional(),
  })
  .strict()
  .openapi("FinanceRequest");

const TimeRequestSchema = z
  .object({
    utc_offset: z.string().regex(/^[+-](?:[01]\d|2[0-3]):[0-5]\d$/),
  })
  .strict()
  .openapi("TimeRequest");

const commonResponses = {
  400: {
    content: { "application/json": { schema: ErrorSchema } },
    description: "The request body is invalid.",
  },
  499: {
    content: { "application/json": { schema: ErrorSchema } },
    description: "The client cancelled the request.",
  },
  502: {
    content: { "application/json": { schema: ErrorSchema } },
    description: "The upstream operation failed.",
  },
  504: {
    content: { "application/json": { schema: ErrorSchema } },
    description: "The upstream operation timed out.",
  },
} as const;

const searchRoute = createRoute({
  method: "post",
  path: "/v1/search",
  operationId: "search",
  summary: "Search the web",
  description:
    "Search through the server-local Kepos Bridge, retrying once through Exa when Bridge is unavailable.",
  request: jsonRequest(SearchRequestSchema),
  responses: {
    200: jsonResponse(SearchResponseSchema, "Search results."),
    ...commonResponses,
  },
});

const fetchRoute = createRoute({
  method: "post",
  path: "/v1/fetch",
  operationId: "fetch",
  summary: "Fetch a web page",
  description:
    "Fetch direct HTML by default; agent-browser rendering requires render=agent-browser and waitMs.",
  request: jsonRequest(FetchRequestSchema),
  responses: {
    200: jsonResponse(FetchResponseSchema, "Fetched page."),
    ...commonResponses,
  },
});

const linksRoute = createRoute({
  method: "post",
  path: "/v1/links",
  operationId: "links",
  summary: "List page links",
  description:
    "List HTTP(S) anchors using direct fetch by default or explicit agent-browser rendering.",
  request: jsonRequest(LinksRequestSchema),
  responses: {
    200: jsonResponse(LinksResponseSchema, "Page links."),
    ...commonResponses,
  },
});

const docsResolveRoute = createRoute({
  method: "post",
  path: "/v1/docs/resolve",
  operationId: "docsResolve",
  summary: "Resolve documentation",
  request: jsonRequest(DocsResolveRequestSchema),
  responses: {
    200: jsonResponse(DocsResolveResponseSchema, "Resolved libraries."),
    ...commonResponses,
  },
});

const docsFetchRoute = createRoute({
  method: "post",
  path: "/v1/docs/fetch",
  operationId: "docsFetch",
  summary: "Fetch documentation",
  request: jsonRequest(DocsFetchRequestSchema),
  responses: {
    200: jsonResponse(DocsFetchResponseSchema, "Documentation content."),
    ...commonResponses,
  },
});

const sourceSearchRoute = createRoute({
  method: "post",
  path: "/v1/source-search",
  operationId: "sourceSearch",
  summary: "Search public source code",
  request: jsonRequest(SourceSearchRequestSchema),
  responses: {
    200: jsonResponse(SourceSearchResponseSchema, "Sourcegraph results."),
    ...commonResponses,
  },
});

const weatherRoute = createRoute({
  method: "post",
  path: "/v1/weather",
  operationId: "weather",
  summary: "Look up weather",
  request: jsonRequest(WeatherRequestSchema),
  responses: {
    200: jsonResponse(KeposResponseSchema, "Weather data."),
    ...commonResponses,
  },
});

const sportsRoute = createRoute({
  method: "post",
  path: "/v1/sports",
  operationId: "sports",
  summary: "Look up sports",
  request: jsonRequest(SportsRequestSchema),
  responses: {
    200: jsonResponse(KeposResponseSchema, "Sports data."),
    ...commonResponses,
  },
});

const financeRoute = createRoute({
  method: "post",
  path: "/v1/finance",
  operationId: "finance",
  summary: "Look up finance",
  request: jsonRequest(FinanceRequestSchema),
  responses: {
    200: jsonResponse(KeposResponseSchema, "Finance data."),
    ...commonResponses,
  },
});

const timeRoute = createRoute({
  method: "post",
  path: "/v1/time",
  operationId: "time",
  summary: "Look up time",
  request: jsonRequest(TimeRequestSchema),
  responses: {
    200: jsonResponse(KeposResponseSchema, "Time data."),
    ...commonResponses,
  },
});

/** Creates the in-process Hono application used by `web serve` and tests. */
export function createHttpApp(
  dependencies: HttpServiceDependencies = {},
): OpenAPIHono {
  const state = resolveHttpServiceState(dependencies);
  const app = new OpenAPIHono({
    defaultHook: (result, context) => {
      if (result.success) return;
      return context.json(
        errorBody("invalid_request", "Request validation failed"),
        400,
      );
    },
  });

  app.openapi(searchRoute, async (context) => {
    const input = context.req.valid("json");
    try {
      const result = await searchWithFallback(
        state,
        input.query,
        context.req.raw.signal,
      );
      return context.json(parseResponse(SearchResponseSchema, result), 200);
    } catch (error) {
      return failureResponse(context, error, "search") as never;
    }
  });

  app.openapi(fetchRoute, async (context) => {
    const input = context.req.valid("json");
    const renderError = validateRenderFields(input.render, input.waitMs);
    if (renderError) return context.json(renderError, 400) as never;
    try {
      const result = await state.operations.fetch(
        input,
        context.req.raw.signal,
      );
      throwIfAborted(context.req.raw.signal);
      return context.json(parseResponse(FetchResponseSchema, result), 200);
    } catch (error) {
      return failureResponse(context, error, "fetch") as never;
    }
  });

  app.openapi(linksRoute, async (context) => {
    const input = context.req.valid("json");
    const renderError = validateRenderFields(input.render, input.waitMs);
    if (renderError) return context.json(renderError, 400) as never;
    try {
      const result = await state.operations.links(
        { ...input, limit: input.limit ?? DEFAULT_LINK_LIMIT },
        context.req.raw.signal,
      );
      throwIfAborted(context.req.raw.signal);
      return context.json(parseResponse(LinksResponseSchema, result), 200);
    } catch (error) {
      return failureResponse(context, error, "links") as never;
    }
  });

  app.openapi(docsResolveRoute, async (context) => {
    const input = context.req.valid("json");
    try {
      const result = await state.operations.docsResolve({
        query: input.query,
        credentials: state.credentials,
        signal: context.req.raw.signal,
      });
      throwIfAborted(context.req.raw.signal);
      return context.json(
        parseResponse(DocsResolveResponseSchema, result),
        200,
      );
    } catch (error) {
      return failureResponse(context, error, "docs resolve") as never;
    }
  });

  app.openapi(docsFetchRoute, async (context) => {
    const input = context.req.valid("json");
    try {
      const result = await state.operations.docsFetch({
        ...input,
        credentials: state.credentials,
        signal: context.req.raw.signal,
      });
      throwIfAborted(context.req.raw.signal);
      return context.json(parseResponse(DocsFetchResponseSchema, result), 200);
    } catch (error) {
      return failureResponse(context, error, "docs fetch") as never;
    }
  });

  app.openapi(sourceSearchRoute, async (context) => {
    const input = context.req.valid("json");
    try {
      const result = await state.operations.sgraphSearch({
        query: input.query,
        count: input.count ?? DEFAULT_SOURCE_COUNT,
        context: input.context ?? DEFAULT_SOURCE_CONTEXT,
        timeout: input.timeout ?? DEFAULT_SOURCE_TIMEOUT,
        signal: context.req.raw.signal,
      });
      throwIfAborted(context.req.raw.signal);
      return context.json(
        parseResponse(SourceSearchResponseSchema, result),
        200,
      );
    } catch (error) {
      return failureResponse(context, error, "source search") as never;
    }
  });

  registerKeposRoute(app, weatherRoute, "weather", "weather", state);
  registerKeposRoute(app, sportsRoute, "sports", "sports", state);
  registerKeposRoute(app, financeRoute, "finance", "finance", state);
  registerKeposRoute(app, timeRoute, "time", "time", state);

  app.onError((error, context) => failureResponse(context, error, "request"));
  app.notFound((context) =>
    context.json(errorBody("not_found", "Route not found"), 404),
  );
  return app;
}

/** Alias retained for callers that refer to the service as an HTTP app. */
export const createHttpService = createHttpApp;

/** Builds the OpenAPI 3.1 document from the registered route schemas. */
export function createHttpOpenAPIDocument(version = "0.1.0") {
  const app = createHttpApp({
    credentials: { exaApiKey: "build-placeholder" },
    keposBridgeEndpoint: DEFAULT_KEPOS_BRIDGE_ENDPOINT,
    validateStartup: false,
  });
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Guion Web Personal HTTP Service",
      version,
      description:
        "Read-only Guion Web research operations and typed Kepos Bridge data operations.",
    },
  });
}

export function resolveHttpServiceState(
  dependencies: HttpServiceDependencies = {},
): HttpServiceState {
  const environment = dependencies.environment ?? process.env;
  const credentials = resolveCredentials(dependencies.credentials, environment);
  if (dependencies.validateStartup !== false) {
    if (
      typeof credentials.exaApiKey !== "string" ||
      credentials.exaApiKey.trim().length === 0
    ) {
      throw new Error(
        "EXA_API_KEY is required and must be non-empty for HTTP service",
      );
    }
  }
  const endpoint =
    dependencies.keposBridgeEndpoint ??
    environment.KEPOS_BRIDGE_ENDPOINT ??
    DEFAULT_KEPOS_BRIDGE_ENDPOINT;
  return {
    operations: dependencies.operations ?? webCoreModule.createWebOperations(),
    credentials,
    keposBridgeEndpoint: validateKeposBridgeEndpoint(endpoint),
  };
}

function resolveCredentials(
  value: HttpServiceDependencies["credentials"],
  environment: NodeJS.ProcessEnv,
): WebCredentials {
  const credentials =
    typeof value === "function"
      ? value()
      : (value ?? credentialsFromEnvironment(environment));
  return { ...credentials };
}

function jsonRequest<T extends z.ZodType>(schema: T) {
  return {
    body: {
      required: true,
      content: { "application/json": { schema } },
    },
  } as const;
}

function jsonResponse<T extends z.ZodType>(schema: T, description: string) {
  return {
    content: { "application/json": { schema } },
    description,
  } as const;
}

function isHttpURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validateRenderFields(
  render: "fetch" | "agent-browser" | undefined,
  waitMs: number | undefined,
): HttpError | undefined {
  const selected = render ?? "fetch";
  if (selected === "fetch" && waitMs !== undefined)
    return errorBody(
      "invalid_request",
      "waitMs is only valid with render agent-browser",
    );
  if (selected === "agent-browser" && waitMs === undefined)
    return errorBody(
      "invalid_request",
      "waitMs is required with render agent-browser",
    );
  return undefined;
}

async function searchWithFallback(
  state: HttpServiceState,
  query: string,
  signal: AbortSignal,
): Promise<SearchResponse> {
  throwIfAborted(signal);
  try {
    const result = await state.operations.search({
      query,
      provider: "kepos-bridge",
      credentials: state.credentials,
      keposBridgeEndpoint: state.keposBridgeEndpoint,
      allowEmptyKeposResults: true,
      signal,
    });
    throwIfAborted(signal);
    return parseResponse(SearchResponseSchema, result);
  } catch (bridgeError) {
    if (isCancellation(bridgeError, signal)) throw bridgeError;
    throwIfAborted(signal);
    try {
      const result = await state.operations.search({
        query,
        provider: "exa",
        credentials: state.credentials,
        signal,
      });
      throwIfAborted(signal);
      return parseResponse(SearchResponseSchema, result);
    } catch (exaError) {
      if (isCancellation(exaError, signal)) throw exaError;
      if (isRequestTimeout(exaError)) throw exaError;
      throw new Error("Search upstream providers failed");
    }
  }
}

function registerKeposRoute<
  R extends RouteConfig,
  Input extends Record<string, unknown>,
>(
  app: OpenAPIHono,
  route: R,
  command: "weather" | "sports" | "finance" | "time",
  operationName: string,
  state: HttpServiceState,
): void {
  (app as any).openapi(route, async (context: any) => {
    const input = context.req.valid("json") as Input;
    try {
      const result = await state.operations.keposBridge({
        endpoint: state.keposBridgeEndpoint,
        commands: { [command]: [input] },
        signal: context.req.raw.signal,
      });
      throwIfAborted(context.req.raw.signal);
      const normalized = normalizeKeposResponse(result);
      return context.json(normalized, 200);
    } catch (error) {
      return failureResponse(context, error, operationName) as never;
    }
  });
}

function isKeposResponse(value: unknown): value is KeposBridgeResponse {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { output?: unknown }).output === "string" &&
    ((value as { results?: unknown }).results === undefined ||
      Array.isArray((value as { results?: unknown }).results))
  );
}

function normalizeKeposResponse(value: unknown): KeposBridgeResponse {
  if (!isKeposResponse(value)) throw new Error("malformed Bridge response");
  return {
    output: value.output,
    ...(value.results === undefined ? {} : { results: value.results }),
  };
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("malformed operation response");
  return parsed.data;
}

function failureResponse(
  context: { json: (body: HttpError, status: number) => Response },
  error: unknown,
  operation: string,
): Response {
  const mapped = classifyFailure(error, operation);
  return context.json(mapped.body, mapped.status);
}

function classifyFailure(
  error: unknown,
  operation: string,
): { status: 400 | 499 | 502 | 504; body: HttpError } {
  if (
    error instanceof HTTPException &&
    error.status >= 400 &&
    error.status < 500
  )
    return {
      status: 400,
      body: errorBody("invalid_request", "Request body is invalid"),
    };
  if (error instanceof SyntaxError)
    return {
      status: 400,
      body: errorBody("invalid_request", "Request body is not valid JSON"),
    };
  if (error instanceof FetchCapabilityError) {
    return {
      status: 502,
      body: {
        code: error.code,
        message: `${operation} requires an explicit capability retry`,
        details: safeFetchDetails(error.details),
      },
    };
  }
  if (isOperationAborted(error) || isAbortError(error))
    return {
      status: 499,
      body: errorBody("request_cancelled", "Request cancelled"),
    };
  if (isRequestTimeout(error))
    return {
      status: 504,
      body: errorBody("upstream_timeout", `${operation} timed out`),
    };
  return {
    status: 502,
    body: errorBody("upstream_error", `${operation} failed`),
  };
}

function errorBody(code: string, message: string): HttpError {
  return { code, message };
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || isOperationAborted(error) || isAbortError(error);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.message === "Operation aborted"))
  );
}

function safeFetchDetails(
  details: FetchCapabilityError["details"],
): Record<string, unknown> | undefined {
  const safe: Record<string, unknown> = {};
  if (typeof details.retryableWithRender === "boolean")
    safe.retryableWithRender = details.retryableWithRender;
  if (typeof details.retryable === "boolean")
    safe.retryable = details.retryable;
  if (
    details.suggestedArguments?.render === "agent-browser" &&
    details.suggestedArguments.waitMs === 2000
  ) {
    safe.suggestedArguments = { render: "agent-browser", waitMs: 2000 };
  }
  if (details.reportUrl === RENDER_REPORT_URL)
    safe.reportUrl = details.reportUrl;
  if (
    typeof details.blockedHostname === "string" &&
    /^[a-z0-9.-]+$/i.test(details.blockedHostname) &&
    details.blockedHostname.length <= 253
  ) {
    safe.blockedHostname = details.blockedHostname.toLowerCase();
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export {
  DocsFetchResponseSchema,
  DocsLibrarySchema,
  DocsResolveResponseSchema,
  ErrorSchema,
  FetchRequestSchema,
  FetchResponseSchema,
  FinanceRequestSchema,
  KeposResponseSchema,
  LinksRequestSchema,
  LinksResponseSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  SourceSearchRequestSchema,
  SportsRequestSchema,
  TimeRequestSchema,
  WeatherRequestSchema,
};
