import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createSSRApp, h, type Component } from "vue";
import { renderToString } from "vue/server-renderer";
import { loadComponent } from "./vue-sfc";

let NoteView: Component;

before(async () => {
  // Enough of a page for the modules the component imports: the language
  // comes from its cookie, and GlimStone listens for how the page is used.
  const listen = () => {};
  Object.assign(globalThis, {
    document: { cookie: "fd_lang=en", documentElement: { lang: "", dir: "" }, addEventListener: listen, removeEventListener: listen },
  });
  NoteView = await loadComponent("src/components/NoteView.vue", { "@glimstone/vue": "test/glimstone-stub.ts" });
});

const render = (text: string) => renderToString(createSSRApp({ render: () => h(NoteView, { text }) }));

test("a note is shown as text, never as HTML", async () => {
  const note = '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:x">hi</a>';
  const html = await render(note);
  assert.ok(!/<img|<script|<a /i.test(html), html);
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"), html);
  assert.ok(html.includes("&lt;script&gt;alert(2)&lt;/script&gt;"), html);
});

test("a note keeps its line breaks and offers a copy button", async () => {
  const html = await render("line one\nline two");
  assert.match(html, /<pre[^>]*>line one\nline two<\/pre>/);
  assert.match(html, /<button[^>]*>.*Copy note.*<\/button>/s);
});
