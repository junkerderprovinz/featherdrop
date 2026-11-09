// The client's routes live in the path, as the server's SPA fallback serves
// the page for any of them: /d/<slug>, /m/<slug>, /note, /request, /r/<slug>,
// /c/<slug> and /settings/<tab>.
import { reactive } from "vue";

const partsOf = () => location.pathname.split("/").filter(Boolean).map(decodeURIComponent);

export const route = reactive({ parts: partsOf() });
addEventListener("popstate", () => {
  route.parts = partsOf();
});

export function go(path: string) {
  if (path === location.pathname + location.hash) return;
  history.pushState(null, "", path);
  route.parts = partsOf();
  scrollTo(0, 0);
}

/** Opens a link of the client in the page itself, and leaves every other click to the browser. */
export function follow(e: MouseEvent, path: string) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go(path);
}
