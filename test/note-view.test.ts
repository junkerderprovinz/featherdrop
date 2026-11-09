import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { initI18n } from "../lib/i18n/config";
import { NoteView } from "../components/NoteView";

function render(text: string): string {
  initI18n("en");
  return renderToStaticMarkup(createElement(MantineProvider, null, createElement(NoteView, { text })));
}

test("a note is shown as text, never as HTML", () => {
  const note = '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:x">hi</a>';
  const html = render(note);
  assert.ok(!/<img|<script|<a /i.test(html), html);
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"), html);
  assert.ok(html.includes("&lt;script&gt;alert(2)&lt;/script&gt;"), html);
});

test("a note keeps its line breaks and offers a copy button", () => {
  const html = render("line one\nline two");
  assert.match(html, /<pre[^>]*>line one\nline two<\/pre>/);
  assert.match(html, /<button[^>]*>.*Copy note.*<\/button>/s);
});
