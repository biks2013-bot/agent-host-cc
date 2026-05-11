import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeCodeRunner } from "../../src/claudeCodeRunner.js";
import { AgentTimeoutError } from "../../src/errors.js";
import type { Provider } from "../../src/types.js";

const FOUNDRY_PROVIDER: Provider = { kind: "anthropic-foundry", apiKey: "F", resource: "R" };
const PUBLIC_PROVIDER: Provider = { kind: "anthropic-public", apiKey: "AK" };

describe("claudeCodeRunner", () => {
  let originalMarker: string | undefined;
  beforeEach(() => {
    originalMarker = process.env.AGENT_HOST_TEST_MARKER;
  });
  afterEach(() => {
    if (originalMarker === undefined) delete process.env.AGENT_HOST_TEST_MARKER;
    else process.env.AGENT_HOST_TEST_MARKER = originalMarker;
  });

  it("invokes SDK with cleanedMessages and Foundry env when provider is anthropic-foundry", async () => {
    (sdkQuery as unknown as { mockReturnValue: (v: unknown) => void })
      .mockReturnValue((async function*() { yield { type: "result", result: "ok" }; })());

    process.env.AGENT_HOST_TEST_MARKER = "marker-value";

    const runner = createClaudeCodeRunner({
      provider: FOUNDRY_PROVIDER, maxTurns: 5, timeoutMs: 5000,
    });
    const events: unknown[] = [];
    for await (const ev of runner.run({
      chatId: "abc", model: "claude-opus-4-7", cwd: "/tmp/abc",
      cleanedMessages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      manifest: [],
    })) events.push(ev);

    const call = (sdkQuery as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const opts = (call[0] as { options: { env: Record<string,string>; cwd: string; model: string } }).options;
    expect(opts.env.CLAUDE_CODE_USE_FOUNDRY).toBe("1");
    expect(opts.env.ANTHROPIC_FOUNDRY_API_KEY).toBe("F");
    expect(opts.env.ANTHROPIC_FOUNDRY_RESOURCE).toBe("R");
    // process.env must be spread first so unrelated parent vars survive.
    expect(opts.env.AGENT_HOST_TEST_MARKER).toBe("marker-value");
    expect(opts.cwd).toBe("/tmp/abc");
    expect(opts.model).toBe("claude-opus-4-7");
    expect(events.length).toBe(1);
  });

  it("invokes SDK with ANTHROPIC_API_KEY (and no Foundry vars) when provider is anthropic-public", async () => {
    (sdkQuery as unknown as { mockReturnValue: (v: unknown) => void; mockClear: () => void }).mockClear();
    (sdkQuery as unknown as { mockReturnValue: (v: unknown) => void })
      .mockReturnValue((async function*() { yield { type: "result", result: "ok" }; })());

    process.env.AGENT_HOST_TEST_MARKER = "marker-public";

    const runner = createClaudeCodeRunner({
      provider: PUBLIC_PROVIDER, maxTurns: 5, timeoutMs: 5000,
    });
    for await (const _ of runner.run({
      chatId: "abc", model: "claude-opus-4-7", cwd: "/tmp/abc",
      cleanedMessages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      manifest: [],
    })) { /* drain */ }

    const calls = (sdkQuery as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const opts = (calls[calls.length - 1]![0] as { options: { env: Record<string,string> } }).options;
    expect(opts.env.ANTHROPIC_API_KEY).toBe("AK");
    expect(opts.env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
    expect(opts.env.ANTHROPIC_FOUNDRY_API_KEY).toBeUndefined();
    expect(opts.env.ANTHROPIC_FOUNDRY_RESOURCE).toBeUndefined();
    expect(opts.env.AGENT_HOST_TEST_MARKER).toBe("marker-public");
  });

  it("times out and throws AgentTimeoutError if SDK never yields", async () => {
    (sdkQuery as unknown as { mockReturnValue: (v: unknown) => void })
      .mockReturnValue((async function*() {
        await new Promise(r => setTimeout(r, 200));
        yield { type: "result", result: "late" };
      })());
    const runner = createClaudeCodeRunner({
      provider: FOUNDRY_PROVIDER, maxTurns: 5, timeoutMs: 50,
    });
    await expect((async () => {
      for await (const _ of runner.run({
        chatId: "abc", model: "x", cwd: "/tmp/abc",
        cleanedMessages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        manifest: [],
      })) { /* drain */ }
    })()).rejects.toBeInstanceOf(AgentTimeoutError);
  });

  it("yields ONLY the latest user message into the SDK prompt iterator", async () => {
    // Regression: when the SPA replays the full conversation history on each
    // turn, the runner used to forward every historical user message as a
    // separate SDK prompt, causing the SDK to regenerate assistant responses
    // for every prior turn. Those replayed responses then streamed back to
    // the SPA and accumulated into the single in-progress assistant bubble.
    //
    // The correct behaviour is to yield only the most recent user turn —
    // each HTTP request is a stateless single-turn run.
    const yieldedUserMessages: unknown[] = [];
    (sdkQuery as unknown as { mockReset: () => void }).mockReset();
    (sdkQuery as unknown as {
      mockImplementation: (fn: (args: { prompt: AsyncIterable<unknown> }) => unknown) => void;
    }).mockImplementation((args) => (async function*() {
      for await (const m of args.prompt) yieldedUserMessages.push(m);
      yield { type: "result", result: "ok" };
    })());

    const runner = createClaudeCodeRunner({
      provider: FOUNDRY_PROVIDER, maxTurns: 5, timeoutMs: 5000,
    });
    for await (const _ of runner.run({
      chatId: "convo-1", model: "claude-opus-4-7", cwd: "/tmp/convo-1",
      cleanedMessages: [
        { role: "user", content: [{ type: "text", text: "first turn" }] },
        { role: "assistant", content: [{ type: "text", text: "first reply" }] },
        { role: "user", content: [{ type: "text", text: "second turn" }] },
        { role: "assistant", content: [{ type: "text", text: "second reply" }] },
        { role: "user", content: [{ type: "text", text: "third turn (latest)" }] },
      ],
      manifest: [],
    })) { /* drain */ }

    expect(yieldedUserMessages).toHaveLength(1);
    const yielded = yieldedUserMessages[0] as {
      type: string;
      message: { role: string; content: Array<{ type: string; text?: string }> };
    };
    expect(yielded.type).toBe("user");
    expect(yielded.message.role).toBe("user");
    // The text block must be the LATEST user turn — never an earlier one.
    const textBlocks = yielded.message.content.filter((b) => b.type === "text");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]!.text).toBe("third turn (latest)");
    // None of the prior user turn texts may leak through.
    expect(textBlocks[0]!.text).not.toContain("first turn");
    expect(textBlocks[0]!.text).not.toContain("second turn");
  });
});
