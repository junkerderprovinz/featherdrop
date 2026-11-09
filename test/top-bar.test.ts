import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createSSRApp, h, type Component } from "vue";
import { renderToString } from "vue/server-renderer";
import { loadComponent } from "./vue-sfc";

let TopBar: Component;

before(async () => {
  const listen = () => {};
  Object.assign(globalThis, {
    document: { cookie: "fd_lang=en", documentElement: { lang: "", dir: "" }, addEventListener: listen, removeEventListener: listen },
    location: { pathname: "/", hash: "" },
    addEventListener: listen,
  });
  TopBar = await loadComponent("src/components/TopBar.vue", { "@glimstone/vue": "test/glimstone-stub.ts" });
});

const render = (screen: string) => renderToString(createSSRApp({ render: () => h(TopBar, { screen }) }));
const backLink = /<a href="\/"[^>]*data-cp="back"[^>]*>Back<\/a>/;

test("the start page offers Settings and no way back", async () => {
  const html = await render("home");
  assert.doesNotMatch(html, /data-cp="back"/);
  assert.match(html, /data-cp="settings"/);
  assert.doesNotMatch(html, /CastleParcel/);
});

test("every other page leads back to the start page from the same place", async () => {
  for (const screen of ["note", "request", "r", "c", "m", "d", "missing"]) {
    const html = await render(screen);
    assert.match(html, backLink, screen);
    assert.ok(html.indexOf('data-cp="back"') < html.indexOf('data-cp="settings"'), `${screen}: back comes first`);
  }
});

test("Settings leads back without offering Settings again", async () => {
  const html = await render("settings");
  assert.match(html, /data-cp="back"[^>]*>Back</);
  assert.doesNotMatch(html, /data-cp="settings"/);
});
