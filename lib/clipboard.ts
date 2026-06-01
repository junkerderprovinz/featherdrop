// Copy text to the clipboard, working even on plain-HTTP LAN access.
//
// navigator.clipboard only exists in a "secure context" (HTTPS or localhost),
// so a self-hosted instance reached at http://192.168.x.x:3000 has no clipboard
// API and the modern path silently fails. We fall back to the legacy
// execCommand('copy') via a hidden textarea, which works without HTTPS.
//
// nav/doc are injectable so the two paths can be unit-tested without a DOM.
export async function copyText(
  text: string,
  nav: Navigator | undefined = typeof navigator !== "undefined"
    ? navigator
    : undefined,
  doc: Document | undefined = typeof document !== "undefined"
    ? document
    : undefined,
): Promise<boolean> {
  // Preferred: the async Clipboard API (secure contexts).
  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }

  // Fallback: a hidden textarea + execCommand('copy'). Works over plain HTTP.
  if (doc?.execCommand) {
    try {
      const ta = doc.createElement("textarea") as HTMLTextAreaElement;
      ta.value = text;
      // Keep it out of view and unscrollable.
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.opacity = "0";
      doc.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange?.(0, text.length);
      const ok = doc.execCommand("copy");
      doc.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  return false;
}
