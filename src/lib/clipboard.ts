interface ClipboardAccess {
  /** The Clipboard API's writeText, when the browser exposes it (secure contexts only). */
  writeText: ((text: string) => Promise<void>) | undefined;
  /** The pre-Clipboard-API fallback; returns whether the copy worked. */
  legacyCopy: (text: string) => boolean;
}

/** Copies through a hidden, selected textarea and `execCommand("copy")`. */
function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  const focused = document.activeElement;
  document.body.append(area);
  try {
    area.select();
    // oxlint-disable-next-line typescript/no-deprecated -- the fallback for browsers without the Clipboard API
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (focused instanceof HTMLElement) {
      focused.focus();
    }
  }
}

function browserClipboard(): ClipboardAccess {
  // Feature detection: navigator.clipboard is missing outside secure contexts,
  // whatever the DOM types say.
  const clipboard: Clipboard | undefined =
    typeof navigator === "undefined" ? undefined : navigator.clipboard;
  return {
    writeText: clipboard ? (text) => clipboard.writeText(text) : undefined,
    legacyCopy,
  };
}

/** Copies `text`, falling back when the Clipboard API is missing or refuses. */
export async function copyText(
  text: string,
  access: ClipboardAccess = browserClipboard(),
): Promise<boolean> {
  if (access.writeText) {
    try {
      await access.writeText(text);
      return true;
    } catch {
      // Try the fallback.
    }
  }
  return access.legacyCopy(text);
}
