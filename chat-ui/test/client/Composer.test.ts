// @vitest-environment jsdom
//
// Integration tests for chat-ui/client/src/components/Composer.tsx.
//
// Covers the two ergonomics behaviours added in feat/ui-input-ergonomics-history:
//
//   1. Submit returns focus to the textarea — including across the
//      streaming → idle disabled-state transition.
//   2. ArrowUp / ArrowDown navigate session-scoped submission history with
//      bash-style draft preservation.
//
// We mock the api + sseClient modules so sendMessage can be driven
// synchronously and we can simulate a streaming round-trip without a
// real fetch.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";

vi.mock("../../client/src/lib/api.js", () => ({
  getProfiles: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
  activateProfile: vi.fn(),
}));

vi.mock("../../client/src/lib/sseClient.js", () => ({
  streamChat: vi.fn(),
  ApiError: class ApiError extends Error {
    public status: number;
    public type: string;
    constructor(args: { status: number; type: string; message: string }) {
      super(args.message);
      this.name = "ApiError";
      this.status = args.status;
      this.type = args.type;
    }
  },
}));

import * as sseClientMock from "../../client/src/lib/sseClient.js";
import type { StreamChatCallbacks } from "../../client/src/lib/sseClient.js";
import { Composer } from "../../client/src/components/Composer.js";
import {
  profiles,
  activeProfileId,
  messages,
  streamingMessageId,
  lastError,
} from "../../client/src/state.js";
import type { RedactedProfile } from "../../client/src/lib/types.js";

// ---------------------------------------------------------------------------
// Test fixtures + helpers
// ---------------------------------------------------------------------------

const fakeProfile = {
  id: "p1",
  name: "local-agent",
  backendKind: "agent-host-cc",
  baseUrl: "http://127.0.0.1:8080",
  apiKey: "<redacted>",
  defaultModel: "claude-opus-4-7",
} as RedactedProfile;

function resetSignals(): void {
  profiles.value = [fakeProfile];
  activeProfileId.value = "p1";
  messages.value = [];
  streamingMessageId.value = null;
  lastError.value = null;
}

/** Make rAF synchronous so focus-restoration effects flush in the same tick. */
function installImmediateRaf(): void {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
}

function mountComposer(): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    render(h(Composer, {}), container);
  });
  return {
    container,
    unmount: () => {
      render(null, container);
      container.remove();
    },
  };
}

function getTextarea(container: HTMLElement): HTMLTextAreaElement {
  const ta = container.querySelector("textarea");
  if (ta === null) throw new Error("textarea not mounted");
  return ta as HTMLTextAreaElement;
}

function type(ta: HTMLTextAreaElement, value: string): void {
  ta.value = value;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

function keydown(
  ta: HTMLTextAreaElement,
  key: string,
  opts: { shiftKey?: boolean } = {},
): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    shiftKey: opts.shiftKey ?? false,
  });
  ta.dispatchEvent(ev);
  return ev;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Composer / focus-return-after-submit", () => {
  beforeEach(() => {
    resetSignals();
    installImmediateRaf();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns focus to the textarea after a streaming round-trip completes", async () => {
    // Drive streamChat: capture callbacks, finish synchronously on demand.
    let onDone: () => void = () => undefined;
    vi.mocked(sseClientMock.streamChat).mockImplementation(
      async (_payload, cbs: StreamChatCallbacks) => {
        onDone = () => cbs.onDone();
      },
    );

    const { container, unmount } = mountComposer();
    const ta = getTextarea(container);
    ta.focus();
    expect(document.activeElement).toBe(ta);

    await act(async () => {
      type(ta, "hello world");
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // Submit via Enter (no shift).
    await act(async () => {
      keydown(ta, "Enter");
      // Let the microtask queue drain so sendMessage's awaits resolve up
      // through `await streamChat(...)`.
      await new Promise((r) => setTimeout(r, 0));
    });

    // While streaming the textarea is disabled and naturally loses focus.
    expect(streamingMessageId.value).not.toBeNull();

    // Server says we're done — disabled flips back to false and the effect
    // should refocus the textarea (rAF is stubbed to be synchronous).
    await act(async () => {
      onDone();
      await new Promise((r) => setTimeout(r, 0));
    });

    const ta2 = getTextarea(container);
    expect(streamingMessageId.value).toBeNull();
    expect(ta2.disabled).toBe(false);
    expect(document.activeElement).toBe(ta2);
    expect(ta2.value).toBe("");

    unmount();
  });
});

describe("Composer / arrow-key history navigation", () => {
  beforeEach(() => {
    resetSignals();
    installImmediateRaf();
    // streamChat returns immediately so each submit cycles cleanly.
    vi.mocked(sseClientMock.streamChat).mockImplementation(
      async (_payload, cbs: StreamChatCallbacks) => {
        cbs.onDone();
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  /** Drain Preact's render queue. */
  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  async function submit(ta: HTMLTextAreaElement, value: string): Promise<void> {
    await act(async () => {
      type(ta, value);
    });
    await flush();
    await act(async () => {
      keydown(ta, "Enter");
    });
    await flush();
  }

  it("Up loads previous entries; Down walks forward", async () => {
    const { container, unmount } = mountComposer();
    let ta = getTextarea(container);

    await submit(ta, "first");
    await submit(ta, "second");
    await submit(ta, "third");

    ta = getTextarea(container);
    expect(ta.value).toBe("");

    act(() => {
      keydown(ta, "ArrowUp");
    });
    ta = getTextarea(container);
    expect(ta.value).toBe("third");

    act(() => {
      keydown(ta, "ArrowUp");
    });
    ta = getTextarea(container);
    expect(ta.value).toBe("second");

    act(() => {
      keydown(ta, "ArrowUp");
    });
    ta = getTextarea(container);
    expect(ta.value).toBe("first");

    act(() => {
      keydown(ta, "ArrowDown");
    });
    ta = getTextarea(container);
    expect(ta.value).toBe("second");

    unmount();
  });

  it("Up from a non-empty input preserves the draft and restores it on Down past newest", async () => {
    const { container, unmount } = mountComposer();
    let ta = getTextarea(container);

    await submit(ta, "old-1");
    await submit(ta, "old-2");

    ta = getTextarea(container);
    await act(async () => {
      type(ta, "draft-in-progress");
    });
    await flush();
    expect(ta.value).toBe("draft-in-progress");

    act(() => {
      keydown(ta, "ArrowUp");
    });
    ta = getTextarea(container);
    expect(ta.value).toBe("old-2");

    act(() => {
      keydown(ta, "ArrowUp");
    });
    ta = getTextarea(container);
    expect(ta.value).toBe("old-1");

    act(() => {
      keydown(ta, "ArrowDown");
    });
    ta = getTextarea(container);
    expect(ta.value).toBe("old-2");

    act(() => {
      keydown(ta, "ArrowDown");
    });
    ta = getTextarea(container);
    expect(ta.value).toBe("draft-in-progress");

    unmount();
  });

  it("ArrowUp does NOT navigate when the caret is not on the first line", async () => {
    const { container, unmount } = mountComposer();
    let ta = getTextarea(container);

    await submit(ta, "history-entry");

    ta = getTextarea(container);
    // Multi-line draft; place caret on the second line.
    await act(async () => {
      type(ta, "line one\nline two");
    });
    await flush();
    ta.setSelectionRange("line one\nline two".length, "line one\nline two".length);

    const ev = keydown(ta, "ArrowUp");
    // Preact synthetic events don't expose defaultPrevented through the
    // native event consistently across versions; verify by observing that
    // the textarea value is unchanged (history did NOT load).
    ta = getTextarea(container);
    expect(ta.value).toBe("line one\nline two");
    // And nothing about the event went weird.
    expect(ev).toBeInstanceOf(KeyboardEvent);

    unmount();
  });
});
