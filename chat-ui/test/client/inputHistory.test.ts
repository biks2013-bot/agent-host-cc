// Unit tests for chat-ui/client/src/lib/inputHistory.ts
//
// Scope: pure history state machine — push / up / down / reset, including
// the bash convention of stashing the live draft on first Up and restoring
// it when Down walks past the most recent entry.

import { describe, it, expect, beforeEach } from "vitest";
import { InputHistory } from "../../client/src/lib/inputHistory.js";

describe("InputHistory / push", () => {
  let h: InputHistory;
  beforeEach(() => {
    h = new InputHistory();
  });

  it("records non-empty entries oldest → newest", () => {
    h.push("ls");
    h.push("pwd");
    h.push("whoami");
    expect(h.size).toBe(3);
  });

  it("ignores whitespace-only entries", () => {
    h.push("   ");
    h.push("");
    h.push("\t\n");
    expect(h.size).toBe(0);
  });

  it("collapses consecutive duplicates", () => {
    h.push("ls");
    h.push("ls");
    h.push("ls");
    expect(h.size).toBe(1);
  });

  it("does NOT collapse non-consecutive duplicates", () => {
    h.push("ls");
    h.push("pwd");
    h.push("ls");
    expect(h.size).toBe(3);
  });

  it("resets navigation state after a push", () => {
    h.push("a");
    h.push("b");
    h.up(""); // index → 1
    h.up(""); // index → 0
    h.push("c");
    expect(h.isNavigating).toBe(false);
  });
});

describe("InputHistory / up & down (bash semantics)", () => {
  let h: InputHistory;
  beforeEach(() => {
    h = new InputHistory();
    h.push("first");
    h.push("second");
    h.push("third");
  });

  it("up from live state returns the most recent entry", () => {
    expect(h.up("")).toBe("third");
  });

  it("up multiple times walks back through history", () => {
    expect(h.up("")).toBe("third");
    expect(h.up("")).toBe("second");
    expect(h.up("")).toBe("first");
  });

  it("up at the oldest entry stays put (does not wrap)", () => {
    h.up("");
    h.up("");
    h.up("");
    // Already at "first"; another up keeps showing "first".
    expect(h.up("")).toBe("first");
  });

  it("down walks forward toward newer entries", () => {
    h.up(""); // third
    h.up(""); // second
    h.up(""); // first
    expect(h.down()).toBe("second");
    expect(h.down()).toBe("third");
  });

  it("down past the newest restores the saved draft", () => {
    h.up("draft-in-progress"); // stashes draft, returns "third"
    expect(h.down()).toBe("draft-in-progress");
    // And we're back in the live state.
    expect(h.isNavigating).toBe(false);
  });

  it("down from the live state is a no-op (returns null)", () => {
    expect(h.down()).toBeNull();
  });

  it("up preserves a non-empty draft and restores it after a full walk back", () => {
    expect(h.up("wip")).toBe("third");
    expect(h.up("wip")).toBe("second");
    expect(h.down()).toBe("third");
    expect(h.down()).toBe("wip");
    expect(h.isNavigating).toBe(false);
  });

  it("up on empty history returns null and does not begin navigating", () => {
    const empty = new InputHistory();
    expect(empty.up("anything")).toBeNull();
    expect(empty.isNavigating).toBe(false);
  });
});

describe("InputHistory / reset", () => {
  it("discards navigation cursor and stashed draft", () => {
    const h = new InputHistory();
    h.push("a");
    h.push("b");
    h.up("draft");
    h.reset();
    expect(h.isNavigating).toBe(false);
    // Subsequent Up should re-stash the new current text, not the old draft.
    expect(h.up("new-draft")).toBe("b");
    expect(h.down()).toBe("new-draft");
  });
});

describe("InputHistory / push during navigation", () => {
  it("pushing a new entry while browsing returns to the live state", () => {
    const h = new InputHistory();
    h.push("a");
    h.push("b");
    h.up(""); // navigating, index=1
    h.up(""); // navigating, index=0
    h.push("c");
    expect(h.size).toBe(3);
    expect(h.isNavigating).toBe(false);
    // Walk back: most recent entry should be "c", not "a".
    expect(h.up("")).toBe("c");
  });
});
