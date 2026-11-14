import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createSSRApp, h, type Component } from "vue";
import { renderToString } from "vue/server-renderer";
import { loadComponent } from "./vue-sfc";

const opened: unknown[] = [];
let Info: Component;

before(async () => {
  const listen = () => {};
  Object.assign(globalThis, {
    document: { cookie: "fd_lang=en", documentElement: { lang: "", dir: "", dataset: {} }, addEventListener: listen, removeEventListener: listen, createElement: () => ({}), querySelectorAll: () => [], body: {} },
    window: { open: (...args: unknown[]) => opened.push(args[0]), addEventListener: listen, removeEventListener: listen, matchMedia: () => ({ matches: false, addEventListener: listen, removeEventListener: listen }) },
    location: { pathname: "/settings/info", hash: "" },
    addEventListener: listen,
  });
  Info = await loadComponent("src/settings/Info.vue");
});

test("showing the Info tab opens no other window", async () => {
  const html = await renderToString(createSSRApp({ render: () => h(Info) }));
  assert.match(html, /CastleParcel/);
  assert.deepEqual(opened, []);
});
