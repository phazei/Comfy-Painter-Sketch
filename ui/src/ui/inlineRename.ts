/**
 * Inline rename field shared by layer rows and output cards: replaces the
 * host's content with a text input. Enter or blur commits, Escape cancels;
 * key and pointer events stay inside the field.
 */

/** Maximum name length typed inline. */
const MAX_NAME_LENGTH = 100;

/**
 * Start renaming inside `host`.
 * @param host - Element whose content the input replaces (the caller restores it).
 * @param initial - Pre-filled, selected text.
 * @param finish - Called once: the typed text on commit, or null on cancel.
 * @returns The input element (already focused).
 */
export function startInlineRename(host: HTMLElement, initial: string, finish: (value: string | null) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "cps-layer-rename";
  input.value = initial;
  input.spellcheck = false;
  input.maxLength = MAX_NAME_LENGTH;
  host.replaceChildren(input);
  let done = false;
  const end = (commit: boolean): void => {
    if (done) return;
    done = true;
    finish(commit ? input.value : null);
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      end(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      end(false);
    }
  });
  input.addEventListener("blur", () => end(true));
  input.addEventListener("pointerdown", (event) => event.stopPropagation());
  input.addEventListener("click", (event) => event.stopPropagation());
  input.focus({ preventScroll: true });
  input.select();
  return input;
}
