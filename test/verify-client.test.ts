import { test } from "node:test";
import assert from "node:assert/strict";
import { manifestFromFiles, manifestJSON } from "../scripts/client-manifest.mjs";
import { shellMatchesTemplate, verifyClient } from "../scripts/verify-client.mjs";

const template = `<!doctype html>
<html lang="%%LANG%%">
  <head>
    <title>%%APP_NAME%%</title>
    <meta property="og:image" content="%%OG_IMAGE%%" />
    <script type="module" crossorigin src="/assets/index-a.js" integrity="sha384-x"></script>
  </head>
  <body><div id="root"></div></body>
</html>
`;

// What the Go server renders for APP_NAME `Tom's "Files" & more`.
const rendered = template
  .replace("%%LANG%%", "en")
  .replace("%%APP_NAME%%", "Tom&#39;s &#34;Files&#34; &amp; more")
  .replace("%%OG_IMAGE%%", "https://drop.example.com/opengraph-image.png");

const release: [string, Uint8Array][] = [
  ["index.html", Buffer.from(template)],
  ["assets/index-a.js", Buffer.from("console.log(1)")],
  ["sw-download.js", Buffer.from("self.onfetch = null")],
];
const manifest = manifestFromFiles(release);

type Routes = Record<string, string | undefined>;

function instance(overrides: Routes = {}): typeof fetch {
  const routes: Routes = {
    "/": rendered,
    "/.well-known/castleparcel-client/index.html": template,
    "/.well-known/castleparcel-client.json": manifestJSON(manifest),
    "/assets/index-a.js": "console.log(1)",
    "/sw-download.js": "self.onfetch = null",
    ...overrides,
  };
  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const body = routes[url.pathname];
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(body, { status: 200 });
  };
}

const verify = (fetch: typeof globalThis.fetch, m = manifest) =>
  verifyClient({ instance: "https://drop.example.com", manifest: m, fetch });

test("an instance serving the release with its own branding passes", async () => {
  const result = await verify(instance());
  assert.deepEqual(result.problems, []);
  assert.equal(result.root, manifest.root);
  assert.equal(result.checked, 3);
});

test("a changed script is named", async () => {
  const result = await verify(instance({ "/assets/index-a.js": "steal(key)" }));
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /assets\/index-a\.js/);
});

test("a missing file is named", async () => {
  const result = await verify(instance({ "/sw-download.js": undefined }));
  assert.match(result.problems.join("\n"), /sw-download\.js.*404/);
});

test("a page with an extra script fails even when the template matches", async () => {
  const page = rendered.replace("</head>", `<script src="/evil.js"></script></head>`);
  const result = await verify(instance({ "/": page }));
  assert.match(result.problems.join("\n"), /page at \/ is not the template/);
});

test("a changed template fails", async () => {
  const result = await verify(instance({
    "/.well-known/castleparcel-client/index.html": template.replace("index-a", "index-b"),
  }));
  assert.match(result.problems.join("\n"), /index\.html/);
});

test("an instance that reports another root is flagged", async () => {
  const other = manifestFromFiles([...release, ["extra.js", Buffer.from("x")]]);
  const result = await verify(instance({
    "/.well-known/castleparcel-client.json": manifestJSON(other),
  }));
  assert.match(result.problems.join("\n"), new RegExp(other.root));
});

test("a manifest whose root does not fit its files is refused", async () => {
  await assert.rejects(
    verify(instance(), { ...manifest, root: "0".repeat(64) }),
    /root/,
  );
});

test("filled markers may only hold escaped text", () => {
  assert.ok(shellMatchesTemplate(template, rendered));
  const breakout = template.replace("%%APP_NAME%%", `x</title><script>alert(1)</script><title>`);
  assert.ok(!shellMatchesTemplate(template, breakout.replace(/%%\w+%%/g, "x")));
  const attribute = template
    .replace(/%%(LANG|APP_NAME)%%/g, "x")
    .replace("%%OG_IMAGE%%", `x" onload="alert(1)`);
  assert.ok(!shellMatchesTemplate(template, attribute));
  assert.ok(!shellMatchesTemplate(template, rendered.replace("sha384-x", "sha384-y")));
});
