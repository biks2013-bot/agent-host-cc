/**
 * Composer — auto-grow text input + Send button.
 *
 * - Enter sends. Shift+Enter inserts a newline.
 * - ArrowUp / ArrowDown navigate session-scoped submission history when
 *   the caret is on the first / last line respectively (shell-style:
 *   the textarea's natural caret movement still wins on intermediate lines).
 * - After a submit, keyboard focus returns to the input as soon as it
 *   becomes interactable again, so the user can keep typing without
 *   reaching for the mouse.
 * - Disabled when no profile is active OR a stream is in progress.
 * - Placeholder shows the active profile's name when one is selected.
 * - Auto-grows up to max-height (capped via CSS); collapses on send.
 */

import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  activeProfileId,
  streamingMessageId,
  profiles,
  sendMessage,
} from "../state";
import { InputHistory } from "../lib/inputHistory";

/**
 * True when the textarea caret is on the first visual line — i.e. there
 * is no newline between the start of the value and the selection start.
 * Used to decide whether ArrowUp should navigate history.
 */
function caretOnFirstLine(ta: HTMLTextAreaElement): boolean {
  return !ta.value.slice(0, ta.selectionStart).includes("\n");
}

/**
 * True when the textarea caret is on the last visual line — i.e. there
 * is no newline between the selection end and the end of the value.
 * Used to decide whether ArrowDown should navigate history.
 */
function caretOnLastLine(ta: HTMLTextAreaElement): boolean {
  return !ta.value.slice(ta.selectionEnd).includes("\n");
}

export function Composer() {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const historyRef = useRef<InputHistory>(new InputHistory());

  // Set whenever the user submits — instructs the effect below to refocus
  // the textarea as soon as `disabled` returns to false. Survives the
  // streaming re-render cycle without polling.
  const wantsFocusRef = useRef(false);

  const activeId = activeProfileId.value;
  const streaming = streamingMessageId.value !== null;
  const disabled = activeId === null || streaming;

  const activeName =
    activeId !== null
      ? (profiles.value.find((p) => p.id === activeId)?.name ?? "")
      : "";

  const placeholder =
    activeId === null
      ? "Pick a profile to start chatting…"
      : streaming
        ? "Streaming reply…"
        : `Message ${activeName}…`;

  // Auto-grow: reset to auto so scrollHeight is the natural content height,
  // then clamp to max via CSS max-height.
  useEffect(() => {
    const el = taRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // Focus-return-after-submit. Runs whenever `disabled` flips. Using rAF
  // ensures focus lands after the disabled→enabled DOM update has flushed
  // (browsers blur a disabled element, so calling focus() synchronously in
  // the same tick can race the disabled toggle).
  useEffect(() => {
    if (!wantsFocusRef.current) return;
    if (disabled) return;
    const el = taRef.current;
    if (el === null) return;
    const raf = requestAnimationFrame(() => {
      el.focus();
    });
    wantsFocusRef.current = false;
    return () => cancelAnimationFrame(raf);
  }, [disabled]);

  const submit = async () => {
    const trimmed = text.trim();
    if (trimmed === "" || disabled) return;
    historyRef.current.push(trimmed);
    setText("");
    if (taRef.current !== null) taRef.current.style.height = "auto";
    wantsFocusRef.current = true;
    try {
      await sendMessage(trimmed);
    } catch {
      // Errors surfaced via lastError in state.ts; nothing to do here.
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    const ta = e.currentTarget as HTMLTextAreaElement;

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
      return;
    }

    if (e.key === "ArrowUp" && caretOnFirstLine(ta)) {
      const next = historyRef.current.up(text);
      if (next !== null) {
        e.preventDefault();
        setText(next);
        // Park the caret at the end of the recalled entry on the next
        // tick (after Preact has flushed the new value to the DOM).
        requestAnimationFrame(() => {
          if (taRef.current !== null) {
            const end = taRef.current.value.length;
            taRef.current.setSelectionRange(end, end);
          }
        });
      }
      return;
    }

    if (e.key === "ArrowDown" && caretOnLastLine(ta)) {
      const next = historyRef.current.down();
      if (next !== null) {
        e.preventDefault();
        setText(next);
        requestAnimationFrame(() => {
          if (taRef.current !== null) {
            const end = taRef.current.value.length;
            taRef.current.setSelectionRange(end, end);
          }
        });
      }
      return;
    }
  };

  return (
    <div>
      <form
        class="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div class="composer__inner">
          <textarea
            ref={taRef}
            class="composer__textarea"
            value={text}
            placeholder={placeholder}
            onInput={(e) =>
              setText((e.currentTarget as HTMLTextAreaElement).value)
            }
            onKeyDown={handleKeyDown}
            disabled={disabled}
            rows={1}
            aria-label="Message input"
          />
          <button
            type="submit"
            class="composer__send"
            disabled={disabled || text.trim() === ""}
            aria-label="Send message"
            title="Send (Enter)"
          >
            ↑
          </button>
        </div>
        <div class="composer__hint">
          {streaming
            ? "Streaming — press Stop in the top bar to cancel."
            : "Enter to send · Shift+Enter for newline · ↑/↓ for history"}
        </div>
      </form>
    </div>
  );
}
