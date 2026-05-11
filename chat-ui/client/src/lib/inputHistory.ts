/**
 * Session-scoped shell-style input history.
 *
 * Mirrors readline / bash semantics:
 *
 *   - `push(entry)` records a submitted entry. Consecutive duplicates are
 *     collapsed (so spamming Enter on the same command doesn't bloat history).
 *     Pushing resets any in-flight navigation cursor.
 *
 *   - `up(currentText)` walks toward older entries. The first Up press from
 *     the live (non-navigating) state stashes the user's current draft so it
 *     can be restored by walking back down past the newest entry.
 *
 *   - `down()` walks toward newer entries. Going past the newest entry
 *     restores the saved draft and returns the cursor to the live state.
 *
 *   - `reset()` discards any in-flight navigation cursor and stashed draft.
 *
 * `up` and `down` return `null` when there is nothing to do (empty history,
 * or Down pressed while already in the live state). Callers use the null
 * signal to leave the input untouched and let the keystroke act normally.
 */
export class InputHistory {
  private entries: string[] = [];

  // `index === null` means "live editing" — the user is on their current
  // draft, not browsing history. Otherwise `index` points into `entries`.
  private index: number | null = null;

  // Saved draft from the moment the user first pressed Up. Restored when
  // Down walks past the most recent entry.
  private draft: string = "";

  /** All recorded entries, oldest → newest. Exposed for tests. */
  get size(): number {
    return this.entries.length;
  }

  /** Whether the cursor is currently browsing history (i.e. not on the draft). */
  get isNavigating(): boolean {
    return this.index !== null;
  }

  /**
   * Record a submitted entry. Whitespace-only entries are ignored — they
   * are not useful to navigate back to. Consecutive duplicates of the most
   * recent entry are also collapsed.
   */
  push(entry: string): void {
    const trimmed = entry.trim();
    if (trimmed === "") {
      this.index = null;
      this.draft = "";
      return;
    }
    const last = this.entries[this.entries.length - 1];
    if (last !== entry) {
      this.entries.push(entry);
    }
    this.index = null;
    this.draft = "";
  }

  /**
   * Walk toward older entries.
   *
   * @param currentText - the input's current value; stashed as the draft
   *   the first time Up is pressed from the live state.
   * @returns the text to put in the input, or `null` if there is no
   *   older entry to show (empty history).
   */
  up(currentText: string): string | null {
    if (this.entries.length === 0) return null;
    if (this.index === null) {
      this.draft = currentText;
      this.index = this.entries.length - 1;
      return this.entries[this.index]!;
    }
    if (this.index > 0) {
      this.index -= 1;
      return this.entries[this.index]!;
    }
    // Already at the oldest entry — stay put, but still return the value
    // so the caller can keep the input synchronised.
    return this.entries[this.index]!;
  }

  /**
   * Walk toward newer entries.
   *
   * @returns the text to put in the input, or `null` if we were already
   *   in the live state (Down from the draft is a no-op).
   */
  down(): string | null {
    if (this.index === null) return null;
    if (this.index < this.entries.length - 1) {
      this.index += 1;
      return this.entries[this.index]!;
    }
    // Past the most recent entry — restore the saved draft and return to
    // the live editing state.
    const restored = this.draft;
    this.index = null;
    this.draft = "";
    return restored;
  }

  /** Forget any in-flight navigation cursor and stashed draft. */
  reset(): void {
    this.index = null;
    this.draft = "";
  }
}
