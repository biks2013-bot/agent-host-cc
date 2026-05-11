// @vitest-environment jsdom
//
// Unit tests for chat-ui/client/src/state.ts
//
// Scope: signal-based state actions — loadProfiles, selectProfile,
// clearTranscript, sendMessage, appendDelta, createProfile, updateProfile,
// deleteProfile, and the messagesForUpstream filter (tested indirectly through
// sendMessage's wire payload).
//
// Strategy: vi.mock the api and sseClient modules; drive sseClient callbacks
// manually inside each test.

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared BEFORE the module under test is imported so
// vi.mock hoisting places them at the top of the transformed file.
// ---------------------------------------------------------------------------

vi.mock("../../client/src/lib/api.js", () => ({
  getProfiles: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
  activateProfile: vi.fn(),
}));

vi.mock("../../client/src/lib/sseClient.js", () => ({
  streamChat: vi.fn(),
  // Re-export ApiError so state.ts can use it
  ApiError: class ApiError extends Error {
    public status: number;
    public type: string;
    public issues?: unknown[];
    constructor(args: { status: number; type: string; message: string }) {
      super(args.message);
      this.name = "ApiError";
      this.status = args.status;
      this.type = args.type;
    }
  },
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import * as apiMock from "../../client/src/lib/api.js";
import * as sseClientMock from "../../client/src/lib/sseClient.js";
import { ApiError } from "../../client/src/lib/types.js";
import type { StreamChatCallbacks } from "../../client/src/lib/sseClient.js";

import {
  profiles,
  activeProfileId,
  messages,
  streamingMessageId,
  lastError,
  loadProfiles,
  selectProfile,
  clearTranscript,
  sendMessage,
  appendDelta,
  createProfile,
  updateProfile,
  deleteProfile,
} from "../../client/src/state.js";

import type { ProfilesListResponse, RedactedProfile } from "../../client/src/lib/types.js";
import { signal } from "@preact/signals";

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const sampleProfile: RedactedProfile = {
  id: "uuid-1",
  name: "local-agent",
  backendKind: "agent-host-cc",
  baseUrl: "http://localhost:8000",
  apiKey: "<redacted>",
  defaultModel: "cc.claude-sonnet-4-6",
} as RedactedProfile;

const anotherProfile: RedactedProfile = {
  id: "uuid-2",
  name: "openai-prod",
  backendKind: "openai",
  baseUrl: "https://api.openai.com",
  apiKey: "<redacted>",
  defaultModel: "gpt-4o",
} as RedactedProfile;

const profilesList: ProfilesListResponse = {
  activeProfileId: "uuid-1",
  profiles: [sampleProfile, anotherProfile],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset all signals to a known-clean baseline before each test. */
function resetState(): void {
  profiles.value = [];
  activeProfileId.value = null;
  messages.value = [];
  streamingMessageId.value = null;
  lastError.value = null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("state / loadProfiles", () => {
  beforeEach(() => {
    resetState();
    vi.mocked(apiMock.getProfiles).mockResolvedValue(profilesList);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("populates profiles.value from the API response", async () => {
    await loadProfiles();

    expect(profiles.value).toHaveLength(2);
    expect(profiles.value[0]!.name).toBe("local-agent");
    expect(profiles.value[1]!.name).toBe("openai-prod");
  });

  it("sets activeProfileId.value from the API response", async () => {
    await loadProfiles();

    expect(activeProfileId.value).toBe("uuid-1");
  });

  it("clears lastError on success", async () => {
    lastError.value = "previous error";
    await loadProfiles();
    expect(lastError.value).toBeNull();
  });

  it("sets lastError when getProfiles throws", async () => {
    vi.mocked(apiMock.getProfiles).mockRejectedValue(
      new ApiError({ status: 500, type: "server_error", message: "Internal server error" }),
    );

    await loadProfiles();

    expect(lastError.value).toMatch(/server_error|Internal server error/);
    // profiles should remain unchanged (empty from reset)
    expect(profiles.value).toHaveLength(0);
  });
});

describe("state / selectProfile", () => {
  beforeEach(() => {
    resetState();
    // Seed profiles so the banner can include the profile name
    profiles.value = [sampleProfile, anotherProfile];
    activeProfileId.value = "uuid-1";
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("updates activeProfileId.value to the newly activated profile", async () => {
    vi.mocked(apiMock.activateProfile).mockResolvedValue({
      activeProfileId: "uuid-2",
    });

    await selectProfile("uuid-2");

    expect(activeProfileId.value).toBe("uuid-2");
  });

  it("inserts a system switch-banner message into messages.value", async () => {
    vi.mocked(apiMock.activateProfile).mockResolvedValue({
      activeProfileId: "uuid-2",
    });

    await selectProfile("uuid-2");

    const sysMessages = messages.value.filter(
      (m) => m.role === "system",
    );
    expect(sysMessages).toHaveLength(1);
    expect(sysMessages[0]!.content.value).toMatch(/switched to profile/);
  });

  it("banner message content starts with the expected prefix used by messagesForUpstream", async () => {
    vi.mocked(apiMock.activateProfile).mockResolvedValue({
      activeProfileId: "uuid-2",
    });

    await selectProfile("uuid-2");

    const banner = messages.value.find((m) => m.role === "system");
    expect(banner).toBeDefined();
    // Must start with the exact prefix the messagesForUpstream filter checks
    expect(banner!.content.value).toMatch(/^— switched to profile/);
  });

  it("preserves existing messages when switching profiles", async () => {
    // Pre-populate with a user message
    const existingMsg = {
      id: "existing-1",
      role: "user" as const,
      content: signal("hi there"),
    };
    messages.value = [existingMsg];

    vi.mocked(apiMock.activateProfile).mockResolvedValue({
      activeProfileId: "uuid-2",
    });

    await selectProfile("uuid-2");

    // Original message should still be present
    expect(messages.value.some((m) => m.id === "existing-1")).toBe(true);
    // Banner is appended, not replacing
    expect(messages.value.length).toBe(2);
  });

  it("sets lastError on activateProfile failure", async () => {
    vi.mocked(apiMock.activateProfile).mockRejectedValue(
      new ApiError({ status: 404, type: "not_found", message: "Profile not found" }),
    );

    await selectProfile("uuid-ghost");

    expect(lastError.value).toMatch(/not_found|Profile not found/);
  });
});

describe("state / clearTranscript", () => {
  beforeEach(() => {
    resetState();
  });

  it("resets messages.value to empty array", () => {
    // Pre-populate with a message that has a real signal
    messages.value = [
      { id: "m1", role: "user", content: signal("hello") },
    ];

    clearTranscript();

    expect(messages.value).toEqual([]);
  });

  it("clears streamingMessageId", () => {
    streamingMessageId.value = "some-id";

    clearTranscript();

    expect(streamingMessageId.value).toBeNull();
  });

  it("clears lastError", () => {
    lastError.value = "some previous error";

    clearTranscript();

    expect(lastError.value).toBeNull();
  });
});

describe("state / appendDelta", () => {
  beforeEach(() => {
    resetState();
  });

  it("mutates the content signal of the target message", () => {
    const contentSignal = signal("Hello");
    messages.value = [
      { id: "msg-1", role: "assistant", content: contentSignal },
    ];

    appendDelta("msg-1", ", world");

    expect(contentSignal.value).toBe("Hello, world");
  });

  it("does NOT replace the messages array (same reference)", () => {
    const contentSignal = signal("");
    const msgArray = [{ id: "msg-2", role: "assistant" as const, content: contentSignal }];
    messages.value = msgArray;
    const originalRef = messages.value;

    appendDelta("msg-2", "token");

    // The messages array itself should not be replaced
    expect(messages.value).toBe(originalRef);
    // But the content signal is mutated
    expect(contentSignal.value).toBe("token");
  });

  it("silently drops delta if message id is not found", () => {
    messages.value = [];

    // Must not throw
    expect(() => appendDelta("ghost-id", "delta")).not.toThrow();
  });
});

describe("state / sendMessage", () => {
  beforeEach(() => {
    resetState();
    // Need an active profile
    activeProfileId.value = "uuid-1";
    profiles.value = [sampleProfile];
    vi.mocked(apiMock.getProfiles).mockResolvedValue(profilesList);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("appends a user message and an assistant placeholder immediately", async () => {
    // streamChat resolves immediately (sync callbacks)
    vi.mocked(sseClientMock.streamChat).mockImplementation(
      async (_body, cbs: StreamChatCallbacks) => {
        cbs.onDone();
      },
    );

    await sendMessage("Hello!");

    expect(messages.value.length).toBe(2);
    expect(messages.value[0]!.role).toBe("user");
    expect(messages.value[0]!.content.value).toBe("Hello!");
    expect(messages.value[1]!.role).toBe("assistant");
  });

  it("sets streamingMessageId during streaming and clears it on onDone", async () => {
    let capturedCbs: StreamChatCallbacks | undefined;
    vi.mocked(sseClientMock.streamChat).mockImplementation(
      async (_body, cbs: StreamChatCallbacks) => {
        capturedCbs = cbs;
        // Don't call onDone yet — let us inspect mid-stream state
      },
    );

    const sendPromise = sendMessage("stream test");

    // Give the microtask queue a tick to run up to the streamChat call
    await new Promise((r) => setTimeout(r, 0));

    // streamingMessageId should be set to the assistant message id
    expect(streamingMessageId.value).not.toBeNull();
    const assistantId = streamingMessageId.value!;
    expect(messages.value.find((m) => m.id === assistantId)?.role).toBe(
      "assistant",
    );

    // Now resolve the stream
    capturedCbs!.onDone();
    await sendPromise;

    expect(streamingMessageId.value).toBeNull();
  });

  it("applies deltas via appendDelta (mutates content signal)", async () => {
    vi.mocked(sseClientMock.streamChat).mockImplementation(
      async (_body, cbs: StreamChatCallbacks) => {
        cbs.onDelta("Hello");
        cbs.onDelta(", world");
        cbs.onDone();
      },
    );

    await sendMessage("test");

    const assistantMsg = messages.value.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content.value).toBe("Hello, world");
  });

  it("clears streamingMessageId on onDone", async () => {
    vi.mocked(sseClientMock.streamChat).mockImplementation(
      async (_body, cbs: StreamChatCallbacks) => {
        cbs.onDone();
      },
    );

    await sendMessage("done test");

    expect(streamingMessageId.value).toBeNull();
  });

  it("sets lastError and clears streamingMessageId on onError", async () => {
    vi.mocked(sseClientMock.streamChat).mockImplementation(
      async (_body, cbs: StreamChatCallbacks) => {
        cbs.onError({ type: "http_error", message: "Connection refused", status: 503 });
      },
    );

    await sendMessage("error test");

    expect(lastError.value).toMatch(/http_error|Connection refused/);
    expect(streamingMessageId.value).toBeNull();
  });

  it("invokes streamChat with the wire messages (excluding switch-banner system rows)", async () => {
    let capturedBody: unknown;
    vi.mocked(sseClientMock.streamChat).mockImplementation(
      async (body, cbs: StreamChatCallbacks) => {
        capturedBody = body;
        cbs.onDone();
      },
    );

    // Pre-seed a switch-banner in the messages
    messages.value = [
      {
        id: "banner-1",
        role: "system",
        content: signal('— switched to profile "local-agent" —'),
      },
      {
        id: "user-1",
        role: "user",
        content: signal("What is 2+2?"),
      },
    ];

    await sendMessage("Continue please");

    const wireBody = capturedBody as { messages: Array<{ role: string; content: string }> };
    // Banner must be filtered out
    const systemMsgs = wireBody.messages.filter((m) => m.role === "system");
    expect(systemMsgs).toHaveLength(0);
    // User message from history should be present
    const userMsgs = wireBody.messages.filter((m) => m.role === "user");
    expect(userMsgs.some((m) => m.content === "What is 2+2?")).toBe(true);
    // New user message also present
    expect(userMsgs.some((m) => m.content === "Continue please")).toBe(true);
  });

  it("sets lastError when there is no active profile", async () => {
    activeProfileId.value = null;

    await sendMessage("hi");

    expect(lastError.value).toMatch(/no active profile/i);
    expect(sseClientMock.streamChat).not.toHaveBeenCalled();
  });

  it("does nothing when text is empty", async () => {
    await sendMessage("");

    expect(sseClientMock.streamChat).not.toHaveBeenCalled();
    expect(messages.value).toHaveLength(0);
  });

  it("renders two consecutive assistant turns as two distinct, non-overlapping messages", async () => {
    // Regression for the "every assistant turn reprints the whole transcript"
    // bug. Each call to sendMessage must produce its own assistant Message
    // with its own content signal — the second bubble must NOT carry any of
    // the first bubble's tokens, even though the underlying signal layer
    // streams deltas live.
    vi.mocked(sseClientMock.streamChat).mockImplementationOnce(
      async (_body, cbs: StreamChatCallbacks) => {
        cbs.onDelta("First ");
        cbs.onDelta("answer.");
        cbs.onDone();
      },
    );

    await sendMessage("First question");

    // After turn 1: [user, assistant]
    expect(messages.value).toHaveLength(2);
    const firstAssistant = messages.value[1]!;
    expect(firstAssistant.role).toBe("assistant");
    expect(firstAssistant.content.value).toBe("First answer.");

    vi.mocked(sseClientMock.streamChat).mockImplementationOnce(
      async (_body, cbs: StreamChatCallbacks) => {
        cbs.onDelta("Second ");
        cbs.onDelta("answer.");
        cbs.onDone();
      },
    );

    await sendMessage("Second question");

    // After turn 2: [user1, assistant1, user2, assistant2] — append-only.
    expect(messages.value).toHaveLength(4);
    const secondAssistant = messages.value[3]!;
    expect(secondAssistant.role).toBe("assistant");
    // The second bubble carries ONLY its own tokens.
    expect(secondAssistant.content.value).toBe("Second answer.");

    // Critically: the two assistant bubbles must be distinct objects with
    // distinct ids and distinct content signals — no shared accumulator.
    expect(secondAssistant.id).not.toBe(firstAssistant.id);
    expect(secondAssistant.content).not.toBe(firstAssistant.content);
    // The first bubble must NOT have absorbed the second turn's tokens.
    expect(firstAssistant.content.value).toBe("First answer.");
    expect(firstAssistant.content.value).not.toContain("Second");
    // And the second bubble must NOT contain any of the first turn's text.
    expect(secondAssistant.content.value).not.toContain("First");
  });
});

describe("state / createProfile (CRUD wrapper)", () => {
  beforeEach(() => {
    resetState();
    vi.mocked(apiMock.getProfiles).mockResolvedValue(profilesList);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls api.createProfile and then refreshes profiles via loadProfiles", async () => {
    vi.mocked(apiMock.createProfile).mockResolvedValue(sampleProfile);

    const input = {
      name: "new-profile",
      backendKind: "openai" as const,
      baseUrl: "https://api.openai.com",
      apiKey: "sk-new",
      defaultModel: "gpt-4o",
    };

    const result = await createProfile(input);

    expect(apiMock.createProfile).toHaveBeenCalledWith(input);
    // loadProfiles is called after creation
    expect(apiMock.getProfiles).toHaveBeenCalled();
    expect(result).toEqual(sampleProfile);
  });

  it("sets lastError and returns null on api.createProfile failure", async () => {
    vi.mocked(apiMock.createProfile).mockRejectedValue(
      new ApiError({ status: 422, type: "invalid_profile", message: "apiKey is required" }),
    );

    const input = {
      name: "bad",
      backendKind: "openai" as const,
      baseUrl: "https://api.openai.com",
      apiKey: "",
      defaultModel: "gpt-4o",
    };

    const result = await createProfile(input);

    expect(result).toBeNull();
    expect(lastError.value).toMatch(/invalid_profile|apiKey is required/);
  });
});

describe("state / updateProfile (CRUD wrapper)", () => {
  beforeEach(() => {
    resetState();
    vi.mocked(apiMock.getProfiles).mockResolvedValue(profilesList);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls api.updateProfile and then refreshes profiles", async () => {
    const updatedProfile: RedactedProfile = {
      ...sampleProfile,
      name: "renamed",
    } as RedactedProfile;
    vi.mocked(apiMock.updateProfile).mockResolvedValue(updatedProfile);

    const input = {
      id: "uuid-1",
      name: "renamed",
      backendKind: "agent-host-cc" as const,
      baseUrl: "http://localhost:8000",
      apiKey: "<redacted>",
      defaultModel: "cc.claude-sonnet-4-6",
    };

    const result = await updateProfile("uuid-1", input);

    expect(apiMock.updateProfile).toHaveBeenCalledWith("uuid-1", input);
    expect(apiMock.getProfiles).toHaveBeenCalled();
    expect(result?.name).toBe("renamed");
  });

  it("sets lastError and returns null on api.updateProfile failure", async () => {
    vi.mocked(apiMock.updateProfile).mockRejectedValue(
      new ApiError({ status: 404, type: "not_found", message: "not found" }),
    );

    const result = await updateProfile("uuid-missing", {
      id: "uuid-missing",
      name: "x",
      backendKind: "openai",
      baseUrl: "https://api.openai.com",
      apiKey: "<redacted>",
      defaultModel: "gpt-4o",
    });

    expect(result).toBeNull();
    expect(lastError.value).toMatch(/not_found|not found/);
  });
});

describe("state / deleteProfile (CRUD wrapper)", () => {
  beforeEach(() => {
    resetState();
    vi.mocked(apiMock.getProfiles).mockResolvedValue(profilesList);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls api.deleteProfile and then refreshes profiles", async () => {
    vi.mocked(apiMock.deleteProfile).mockResolvedValue(undefined);

    const ok = await deleteProfile("uuid-1");

    expect(apiMock.deleteProfile).toHaveBeenCalledWith("uuid-1");
    expect(apiMock.getProfiles).toHaveBeenCalled();
    expect(ok).toBe(true);
  });

  it("sets lastError and returns false on api.deleteProfile failure", async () => {
    vi.mocked(apiMock.deleteProfile).mockRejectedValue(
      new ApiError({ status: 404, type: "not_found", message: "Profile uuid-ghost not found" }),
    );

    const ok = await deleteProfile("uuid-ghost");

    expect(ok).toBe(false);
    expect(lastError.value).toMatch(/not_found|not found/i);
  });
});
