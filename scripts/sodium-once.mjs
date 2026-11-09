// The client bundles libsodium once, inside the crypto worker, which the main
// chunk carries as a string. A page module that imports libsodium again would
// ship a second copy and nearly double the download, so the build counts the
// copies. The marker is the WebAssembly module libsodium embeds as base64,
// read from the installed package: it is most of libsodium's weight, no
// minifier touches a string literal, and it follows every libsodium update.

/** The base64 WebAssembly module embedded in libsodium-sumo.mjs. */
export function sodiumWasm(source) {
  const m = source.match(/(["'`])(AGFzbQ[A-Za-z0-9+/=]+)\1/);
  if (!m) throw new Error("libsodium-sumo.mjs holds no base64 WebAssembly module");
  return m[2];
}

function count(text, needle) {
  let n = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) n++;
  return n;
}

/**
 * Throws unless the built scripts hold libsodium exactly once.
 * @param {{ path: string, text: string }[]} scripts
 * @param {string} wasm the module sodiumWasm returns
 */
export function checkSodiumOnce(scripts, wasm) {
  const found = scripts.map((s) => ({ path: s.path, n: count(s.text, wasm) })).filter((s) => s.n > 0);
  const total = found.reduce((sum, s) => sum + s.n, 0);
  if (total === 0) {
    throw new Error("no copy of libsodium's WebAssembly in the built scripts, so this check cannot see it");
  }
  if (total > 1) {
    throw new Error(
      `${total} copies of libsodium in ${found.map((s) => s.path).join(", ")}; ` +
        "the page has to leave libsodium to the crypto worker",
    );
  }
}
