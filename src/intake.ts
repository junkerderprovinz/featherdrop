// How files reach the page: the picker, a drop anywhere on the page, a paste
// or the share sheet of the system. The page has one file input, and the
// screen on show decides what the files are for.
import { ref } from "vue";
import { filesFromDropEvent } from "@/lib/dropped-files";
import { collectSharedFiles, isShareTargetLaunch } from "@/lib/share-target";
import { prefs } from "@/src/prefs";

type Taker = (files: File[]) => void;

let taker: Taker | null = null;
export const dragging = ref(false);
let input: HTMLInputElement | null = null;

export const setInput = (el: unknown) => {
  input = el as HTMLInputElement | null;
};

/** Gives picked, dropped and pasted files to take until the returned function is called. */
export function takeFiles(take: Taker) {
  taker = take;
  return () => {
    if (taker === take) taker = null;
  };
}

export function pickFiles() {
  input?.click();
}

export function picked(e: Event) {
  const files = filesFromDropEvent(e);
  // Otherwise picking the same file again fires no change event.
  (e.target as HTMLInputElement).value = "";
  if (files.length) taker?.(files);
}

export function installIntake() {
  addEventListener("dragover", (e) => {
    if (!taker || !e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    dragging.value = true;
  });
  addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) dragging.value = false;
  });
  addEventListener("drop", (e) => {
    dragging.value = false;
    const files = filesFromDropEvent(e);
    if (!taker || !files.length) return;
    e.preventDefault();
    taker(files);
  });
  // A paste into a field is the field's, so only a paste elsewhere on the page picks up files.
  document.addEventListener("paste", (e) => {
    const el = document.activeElement;
    if (!prefs.paste || !taker || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    taker(files);
  });
}

/** Files shared to the installed app from the system's share sheet, once. */
export async function sharedFiles(): Promise<File[]> {
  if (!isShareTargetLaunch()) return [];
  const files = await collectSharedFiles();
  // Otherwise a reload would look like a new share.
  history.replaceState(null, "", "/");
  return files;
}
