// IME composition state machine. Framework-agnostic so it's unit-testable; the
// Vue host wires DOM composition events (and a hidden cursor-tracked input) to
// these methods, renders `onPreedit` inline, and sends `onCommit` text to the
// server. While composing, keydown-derived sends are suppressed by the host
// checking `composing`.

export class Ime {
  composing = false;
  preedit = '';

  /** Called with the in-progress composition string (empty to clear). */
  onPreedit?: (text: string) => void;
  /** Called with the committed text on composition end. */
  onCommit?: (text: string) => void;

  start(): void {
    this.composing = true;
    this.preedit = '';
    this.onPreedit?.('');
  }

  update(text: string): void {
    if (!this.composing) return;
    this.preedit = text;
    this.onPreedit?.(text);
  }

  end(text: string): void {
    this.composing = false;
    this.preedit = '';
    this.onPreedit?.('');
    if (text) this.onCommit?.(text);
  }

  cancel(): void {
    this.composing = false;
    this.preedit = '';
    this.onPreedit?.('');
  }
}
