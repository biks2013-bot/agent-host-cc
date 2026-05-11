import { query } from "@anthropic-ai/claude-agent-sdk";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";
import { AgentRunError, AgentTimeoutError } from "./errors.js";
import type { AgentRunner, RunRequest } from "./agentRunner.js";
import type { ContentPart, Message, Provider } from "./types.js";

export interface ClaudeCodeRunnerOptions {
  provider: Provider;
  maxTurns: number;
  timeoutMs: number;
}

// Resolve the bundled `claude` native binary that ships with the SDK.
// The SDK's own auto-detection (`require.resolve` of the platform package
// from inside the SDK's CJS context) fails when the SDK is loaded from an
// ESM consumer in some Node 22 + Alpine + virtiofs combinations, so we
// resolve it ourselves once at module load and pass it via
// `options.pathToClaudeCodeExecutable`.
const resolveClaudeExecutable = (): string | undefined => {
  const platform = process.platform;
  const arch = process.arch;
  const ext = platform === "win32" ? ".exe" : "";
  const candidates = platform === "linux"
    ? [`@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude${ext}`,
       `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude${ext}`]
    : [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude${ext}`];
  const req = createRequire(import.meta.url);
  for (const c of candidates) {
    try { return req.resolve(c); } catch { /* try next */ }
  }
  return undefined;
};

const CLAUDE_EXECUTABLE_PATH = resolveClaudeExecutable();

// Settings layers the Claude Agent SDK is told to load. "user" enables
// ~/.claude/settings.json + ~/.claude/plugins/** (so plugin-provided skills,
// agents, and commands are discovered when the host's ~/.claude is bind-mounted
// into the container). "project" enables <cwd>/.claude/**. "local" enables
// <cwd>/.claude/settings.local.json. The /skills debug endpoint echoes the
// same constant so introspection matches actual SDK behaviour.
export const CLAUDE_SETTING_SOURCES = ["user", "project", "local"] as const;

// ---------------------------------------------------------------------------
// preview(): UTF-8-safe truncation + secret scrub helper.
//
// Used by the agent.* Pino log lines (session-init, tool-use, tool-result,
// assistant-text, end-of-turn) emitted from run() below.
//
// Pino's `redact` list cannot reach inside arbitrary tool inputs/outputs, so
// the *value* placed into Pino is pre-scrubbed here. This helper applies a
// regex scrub for the two leakage shapes seen in practice: `sk-...` API keys
// and `Bearer <token>` headers. Truncation is
// to a UTF-8 byte budget (NOT character count) so multi-byte runes are not
// chopped mid-codepoint, and an ellipsis suffix marks the truncation.
// ---------------------------------------------------------------------------
const SECRET_SCRUB_RE = /sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9_.+/=-]+/g;

const preview = (value: unknown, maxBytes = 256): string => {
  const raw = typeof value === "string" ? value : safeStringify(value);
  const scrubbed = raw.replace(SECRET_SCRUB_RE, "[REDACTED]");
  return truncateToBytes(scrubbed, maxBytes);
};

const safeStringify = (value: unknown): string => {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
};

const truncateToBytes = (s: string, maxBytes: number): string => {
  const enc = new TextEncoder();
  const bytes = enc.encode(s);
  if (bytes.length <= maxBytes) return s;
  // Decode the first maxBytes bytes; TextDecoder with fatal=false silently
  // drops a partial trailing codepoint so we never split a multi-byte rune.
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, maxBytes));
  return head + "…";
};

// ---------------------------------------------------------------------------
// emitAgentLog(): inspect one Claude Agent SDK message and emit the
// corresponding agent.* Pino log line, per the plan-002 §A mapping table.
// MUST NOT throw — the runner is in the middle of yielding events to the
// HTTP adapters and any exception here would surface as an internal 500.
// ---------------------------------------------------------------------------
type AgentLogger = Pick<FastifyBaseLogger, "info">;

const emitAgentLog = (log: AgentLogger, ev: unknown): void => {
  try {
    if (typeof ev !== "object" || ev === null) return;
    const e = ev as { type?: string };

    // (1) agent.session-init — SDK system/init message
    if (e.type === "system") {
      const sys = ev as { subtype?: string; model?: string };
      if (sys.subtype === "init" && typeof sys.model === "string") {
        log.info({ event: "session-init", model: sys.model }, "agent.session-init");
      }
      return;
    }

    // (2) agent.assistant-text and (3) agent.tool-use — assistant message
    //     content blocks (one log line per block).
    if (e.type === "assistant") {
      const asst = ev as { message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> } };
      const blocks = asst.message?.content ?? [];
      for (const blk of blocks) {
        if (blk.type === "text" && typeof blk.text === "string" && blk.text.length > 0) {
          log.info({ event: "assistant-text", text: preview(blk.text) }, "agent.assistant-text");
        } else if (blk.type === "tool_use") {
          log.info(
            { event: "tool-use", name: blk.name ?? "(unknown)", inputPreview: preview(blk.input) },
            "agent.tool-use",
          );
        }
      }
      return;
    }

    // (4) agent.tool-result — user message carrying tool_result blocks
    //     (the SDK wraps tool outputs in a synthetic user message).
    if (e.type === "user") {
      const usr = ev as { message?: { content?: unknown }; tool_use_result?: unknown };
      const content = usr.message?.content;
      if (Array.isArray(content)) {
        for (const blk of content) {
          if (blk && typeof blk === "object" && (blk as { type?: string }).type === "tool_result") {
            const tr = blk as { is_error?: boolean; content?: unknown };
            log.info(
              { event: "tool-result", ok: tr.is_error !== true, preview: preview(tr.content) },
              "agent.tool-result",
            );
          }
        }
      }
      return;
    }

    // (5) agent.end-of-turn — SDK result message (success or error).
    if (e.type === "result") {
      const res = ev as {
        num_turns?: number;
        total_cost_usd?: number;
        usage?: unknown;
      };
      log.info(
        {
          event: "end-of-turn",
          turns: typeof res.num_turns === "number" ? res.num_turns : 0,
          costUsd: typeof res.total_cost_usd === "number" ? res.total_cost_usd : 0,
          usagePreview: preview(res.usage),
        },
        "agent.end-of-turn",
      );
      return;
    }
  } catch {
    // Logging is best-effort; never let a malformed SDK event crash the run.
  }
};

const toSdkUserMessage = (m: Message, sessionId: string) => {
  const content = Array.isArray(m.content)
    ? m.content.map((p: ContentPart) => {
        if (p.type === "text") return { type: "text" as const, text: p.text };
        const u = p.image_url.url;
        const match = /^data:([^;]+);base64,(.+)$/.exec(u);
        if (!match) return { type: "text" as const, text: `(image: ${u})` };
        return {
          type: "image" as const,
          source: { type: "base64" as const, media_type: match[1] as string, data: match[2] as string },
        };
      })
    : m.content;
  return {
    type: "user" as const,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: "user" as const, content },
  };
};

const buildProviderEnv = (provider: Provider): Record<string, string> => {
  if (provider.kind === "anthropic-foundry") {
    return {
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_API_KEY: provider.apiKey,
      ANTHROPIC_FOUNDRY_RESOURCE: provider.resource,
    };
  }
  return {
    ANTHROPIC_API_KEY: provider.apiKey,
  };
};

export const createClaudeCodeRunner = (opts: ClaudeCodeRunnerOptions): AgentRunner => ({
  async *run(req: RunRequest) {
    const sessionId = `${req.chatId}-${Date.now()}`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs);

    // The Claude Agent SDK spawns the `claude` binary with cwd=req.cwd. If
    // the cwd doesn't exist, child_process.spawn returns ENOENT — which the
    // SDK then misreports as "Claude Code native binary not found at <path>".
    // For text-only turns the workspaceManager never created the chat dir
    // (no attachments to write), so we ensure it exists here.
    await mkdir(req.cwd, { recursive: true });

    // Yield ONLY the latest user turn into the SDK prompt iterator. Each
    // /v1/chat/completions HTTP request is a stateless single-turn run, so
    // replaying every historical user message would make the SDK regenerate
    // the assistant response for each prior turn; the openAiChatSseAdapter
    // would then emit every replayed turn as deltas, and any OpenAI-shaped
    // client (including the chat-ui SPA) would concatenate them into the
    // single in-progress assistant bubble — producing the "every reply
    // reprints the whole transcript" UI bug. Cross-turn state lives in the
    // per-chat workspace (cwd), not in SDK session memory.
    const userMessages = req.cleanedMessages.filter((m) => m.role === "user");
    const latestUserMessage = userMessages[userMessages.length - 1];
    async function* prompt() {
      if (latestUserMessage !== undefined) {
        yield toSdkUserMessage(latestUserMessage, sessionId);
      }
    }

    // Spread process.env first so the SDK inherits PATH, HOME, etc. — the
    // upstream SDK still treats `env` as a full replacement on some paths
    // (per ADR-5), so we must not pass a sparse object.
    const providerEnv = buildProviderEnv(opts.provider);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...providerEnv,
    };
    // The provider field is authoritative. If the parent process happens to
    // have legacy Foundry env vars set but the configured provider is the
    // public Anthropic API, strip them so the SDK does not silently route to
    // Foundry. (Symmetric stripping for the foundry path is unnecessary —
    // ANTHROPIC_API_KEY is harmless when CLAUDE_CODE_USE_FOUNDRY=1.)
    if (opts.provider.kind === "anthropic-public") {
      delete env.CLAUDE_CODE_USE_FOUNDRY;
      delete env.ANTHROPIC_FOUNDRY_API_KEY;
      delete env.ANTHROPIC_FOUNDRY_RESOURCE;
    }

    let timedOut = false;
    ctrl.signal.addEventListener("abort", () => {
      timedOut = true;
    });

    try {
      // The SDK's prompt and options types are complex generics; we trust the
      // structure matches at runtime (verified by integration tests).
      const sdkOptions: Record<string, unknown> = {
        model: req.model,
        cwd: req.cwd,
        maxTurns: opts.maxTurns,
        env,
        abortController: ctrl,
        tools: { type: "preset", preset: "claude_code" },
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: CLAUDE_SETTING_SOURCES,
        // Bypass interactive permission prompts. The agent runs as a non-root
        // user inside an isolated container with only /workspace writable,
        // and there is no UI on this path to answer permission questions.
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      };
      if (CLAUDE_EXECUTABLE_PATH) sdkOptions.pathToClaudeCodeExecutable = CLAUDE_EXECUTABLE_PATH;
      const it = (query as unknown as (args: unknown) => AsyncIterable<unknown>)({
        prompt: prompt(),
        options: sdkOptions,
      });
      for await (const ev of it) {
        if (timedOut) throw new AgentTimeoutError();
        // ---------------------------------------------------------------
        // agent.* Pino instrumentation. Side-effect only — the SDK event
        // is still yielded unchanged below. Five branches, one per SDK
        // message shape:
        //   system/init   → agent.session-init
        //   assistant     → agent.tool-use OR agent.assistant-text per block
        //   user (tool_result block) → agent.tool-result
        //   result        → agent.end-of-turn
        // ---------------------------------------------------------------
        if (req.log) {
          emitAgentLog(req.log, ev);
        }
        yield ev;
      }
      if (timedOut) throw new AgentTimeoutError();
    } catch (err) {
      if (err instanceof AgentTimeoutError) throw err;
      if (timedOut) throw new AgentTimeoutError();
      throw new AgentRunError(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timeout);
    }
  },
});
