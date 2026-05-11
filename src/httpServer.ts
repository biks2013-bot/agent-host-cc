import Fastify from "fastify";
import { ChatCompletionRequestSchema, ResponsesRequestSchema } from "./types.js";
import {
  AgentHostError, InvalidRequestError, ModelNotFoundError, UnauthorizedError,
} from "./errors.js";
import type { AgentRunner } from "./agentRunner.js";
import type { createAttachmentProcessor } from "./attachmentProcessor.js";
import { adaptToOpenAiSse } from "./openAiChatSseAdapter.js";
import {
  adaptToOpenAiResponseSse,
  aggregateResponsesNonStreaming,
  translateResponsesInputToMessages,
  type ToolUseRendering,
} from "./openAiResponseAdapter.js";
import { createReadStream, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { introspectClaudeMount } from "./skillsIntrospector.js";
import { CLAUDE_SETTING_SOURCES } from "./claudeCodeRunner.js";

export interface HttpServerOptions {
  apiKey: string;
  modelIds: string[];
  modelPrefix: string;
  workspaceDir: string;
  attachmentProcessor: ReturnType<typeof createAttachmentProcessor>;
  agentRunner: AgentRunner;
  /**
   * Tool-use rendering strategy on the Responses surface. v1 only supports
   * `"text"` (italic-markdown shim, identical to Chat). `"item"` is reserved
   * for a future release and rejected at config load.
   */
  responsesToolUseRendering?: ToolUseRendering;
}

export const buildApp = (opts: HttpServerOptions) => {
  const stripPrefix = (m: string): string => {
    if (opts.modelPrefix === "") return m;
    return m.startsWith(opts.modelPrefix) ? m.slice(opts.modelPrefix.length) : m;
  };

  const app = Fastify({
    // Accommodate base64-encoded images and other modest binaries posted
    // as `image_url` data URLs by clients. Fastify's default 1 MB limit
    // is well below typical screenshots.
    bodyLimit: 64 * 1024 * 1024, // 64 MB
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // NOTE: the agent.* event lines emitted from claudeCodeRunner.ts pass
      // tool inputs / outputs through preview(), which truncates AND scrubs
      // known secret patterns (api keys, bearer tokens) before logging.
      // Therefore we do NOT list inputPreview / preview / usagePreview here
      // (redacting them would mask the agent telemetry); secret hygiene is handled
      // upstream of Pino in the preview() helper.
      redact: ["req.headers.authorization"],
    },
  });

  const requireAuth = (req: { headers: Record<string, unknown> }) => {
    const h = req.headers.authorization as string | undefined;
    if (!h || h !== `Bearer ${opts.apiKey}`) throw new UnauthorizedError();
  };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AgentHostError) {
      reply.code(err.httpStatus).send(err.toErrorEnvelope());
      return;
    }
    // Fastify-native errors (e.g. FST_ERR_CTP_BODY_TOO_LARGE) carry an
    // intended HTTP statusCode and a stable `code`. Surface those instead
    // of opaque 500s, so callers see meaningful errors.
    const fastifyErr = err as { statusCode?: number; code?: string };
    if (typeof fastifyErr.statusCode === "number" && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 600) {
      const code = typeof fastifyErr.code === "string" ? fastifyErr.code : "fastify_error";
      req.log.warn({ err, url: req.url }, "fastify error");
      reply.code(fastifyErr.statusCode).send({
        error: { type: code, message: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    req.log.error({ err, url: req.url }, "internal error in request handler");
    reply.code(500).send({
      error: {
        type: "internal",
        message: err instanceof Error ? err.message : "Internal error",
      },
    });
  });

  app.get("/healthz", async () => ({ ok: true }));

  // Debug endpoint: walks the filesystem inside the running container to show
  // what the Claude Agent SDK *would* discover given the configured
  // settingSources. Useful for verifying that the bind-mount of ~/.claude is
  // present and that plugin-provided skills are visible. Requires the same
  // bearer token as the OpenAI-shaped endpoints. The body is a filesystem
  // snapshot — it does not call the SDK and may diverge from runtime state if
  // the SDK ignores something we list.
  app.get("/skills", async (req) => {
    requireAuth(req);
    const claudeDir = join(homedir(), ".claude");
    return introspectClaudeMount({
      claudeDir,
      projectDir: opts.workspaceDir,
      settingSources: CLAUDE_SETTING_SOURCES,
    });
  });

  app.get("/v1/models", async (req) => {
    requireAuth(req);
    return {
      object: "list",
      data: opts.modelIds.map(id => ({ id, object: "model", created: 0, owned_by: "agent-host" })),
    };
  });

  app.get<{ Params: { chatId: string; "*": string } }>("/files/:chatId/*", async (req, reply) => {
    requireAuth(req);
    const chatId = req.params.chatId;
    const rel = (req.params["*"] ?? "") as string;
    const target = resolve(opts.workspaceDir, chatId, rel);
    const root = resolve(opts.workspaceDir, chatId);
    if (!target.startsWith(root + sep)) {
      reply.code(400).send({ error: { type: "invalid_request", message: "path escapes chat workspace" } });
      return;
    }
    try {
      const st = statSync(target);
      if (!st.isFile()) {
        reply.code(404).send({ error: { type: "not_found", message: "not a file" } });
        return;
      }
      reply.type("application/octet-stream");
      return reply.send(createReadStream(target));
    } catch {
      reply.code(404).send({ error: { type: "not_found", message: "file not found" } });
    }
  });

  app.post("/v1/chat/completions", async (req, reply) => {
    requireAuth(req);
    const parsed = ChatCompletionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new InvalidRequestError(
        "request body validation failed",
        parsed.error.issues.map(i => ({ path: i.path as (string | number)[], message: i.message })),
      );
    }
    const r = parsed.data;
    const model = stripPrefix(r.model);
    if (!opts.modelIds.includes(model)) throw new ModelNotFoundError(model);

    const chatId = r.metadata?.chat_id ?? deriveChatId(r);
    const proc = await opts.attachmentProcessor.process({
      chatId, messages: r.messages, files: r.files ?? [],
    });

    const events = opts.agentRunner.run({
      chatId, model, cwd: join(opts.workspaceDir, chatId),
      cleanedMessages: proc.cleanedMessages, manifest: proc.manifest,
      log: req.log,
    });

    if (r.stream === false) {
      // Non-streaming aggregate path
      let full = "";
      for await (const ev of events as AsyncIterable<unknown>) {
        const e = ev as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
        if (e.type === "assistant" && e.message?.content) {
          for (const b of e.message.content) if (b.type === "text" && b.text) full += b.text;
        }
      }
      return {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: "stop" }],
      };
    }

    reply.raw.setHeader("content-type", "text/event-stream");
    reply.raw.setHeader("cache-control", "no-cache");
    reply.raw.setHeader("connection", "keep-alive");
    const header = { id: `chatcmpl-${Date.now()}`, model, created: Math.floor(Date.now() / 1000) };
    for await (const chunk of adaptToOpenAiSse(events as AsyncIterable<unknown>, header)) {
      reply.raw.write(chunk);
    }
    reply.raw.end();
  });

  app.post("/v1/responses", async (req, reply) => {
    requireAuth(req);
    const parsed = ResponsesRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new InvalidRequestError(
        "request body validation failed",
        parsed.error.issues.map(i => ({ path: i.path as (string | number)[], message: i.message })),
      );
    }
    const r = parsed.data;
    const model = stripPrefix(r.model);
    if (!opts.modelIds.includes(model)) throw new ModelNotFoundError(model);

    const messages = translateResponsesInputToMessages(r.input);
    const chatId = r.metadata?.chat_id ?? deriveChatIdFromMessages(messages);

    const proc = await opts.attachmentProcessor.process({
      chatId,
      messages,
      files: (r.files ?? []).map(f => ({ type: "file" as const, id: f.id, name: f.name })),
    });

    const events = opts.agentRunner.run({
      chatId, model, cwd: join(opts.workspaceDir, chatId),
      cleanedMessages: proc.cleanedMessages, manifest: proc.manifest,
      log: req.log,
    });

    const toolUseRendering: ToolUseRendering = opts.responsesToolUseRendering ?? "text";

    if (r.stream === false) {
      const body = await aggregateResponsesNonStreaming(events as AsyncIterable<unknown>, {
        model, toolUseRendering,
      });
      reply.code(200).type("application/json");
      return body;
    }

    reply.raw.setHeader("content-type", "text/event-stream");
    reply.raw.setHeader("cache-control", "no-cache");
    reply.raw.setHeader("connection", "keep-alive");
    for await (const chunk of adaptToOpenAiResponseSse(events as AsyncIterable<unknown>, {
      model, toolUseRendering,
    })) {
      reply.raw.write(chunk);
    }
    reply.raw.end();
  });

  return app;
};

const deriveChatId = (r: { messages: { role: string; content: unknown }[] }): string =>
  deriveChatIdFromMessages(r.messages);

const deriveChatIdFromMessages = (messages: { role: string; content: unknown }[]): string => {
  const first = messages.find(m => m.role === "user");
  const text = typeof first?.content === "string" ? first.content : JSON.stringify(first?.content ?? "");
  let h = 0;
  for (let i = 0; i < Math.min(200, text.length); i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return `derived-${h.toString(16).padStart(8, "0")}`;
};
