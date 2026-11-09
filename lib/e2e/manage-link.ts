// The management link lets the uploader delete a share before it expires. Its
// token is made here and rides in the link's fragment like the content key;
// the server stores only base64url(SHA-256(token)), so neither it nor a copy
// of its database can delete a share. Hashing uses libsodium because
// crypto.subtle is missing on plain HTTP.

type Sodium = typeof import("libsodium-wrappers-sumo");

async function loadSodium(): Promise<Sodium> {
  const mod = await import("libsodium-wrappers-sumo");
  // With bundler interop the CJS module arrives as { default }, without it as
  // the object itself.
  const lib =
    (mod as unknown as { default?: Sodium }).default ?? (mod as unknown as Sodium);
  await lib.ready;
  return lib;
}

/** The secret of a management link and the hash finalize stores. */
export interface ManageToken {
  token: string;
  hash: string;
}

/** Returns a new token of 32 random bytes as unpadded base64url, and its hash. */
export async function createManageToken(): Promise<ManageToken> {
  const sodium = await loadSodium();
  const token = sodium.to_base64(
    sodium.randombytes_buf(32),
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
  return { token, hash: await hashManageToken(token) };
}

/** Returns base64url(SHA-256(token)), as the server's share.HashManageToken. */
export async function hashManageToken(token: string): Promise<string> {
  const sodium = await loadSodium();
  return sodium.to_base64(
    sodium.crypto_hash_sha256(token),
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
}

/** Builds the link the uploader keeps: https://host/m/<slug>#t=<token>. */
export function manageUrl(baseUrl: string, slug: string, token: string): string {
  return `${baseUrl}/m/${encodeURIComponent(slug)}#t=${token}`;
}

/** Reads the token from a management link's fragment, "" when there is none. */
export function manageTokenFromFragment(fragment: string): string {
  return new URLSearchParams(fragment.replace(/^#/, "")).get("t") ?? "";
}

/**
 * Deletes a share with its manage token. The token goes in a header, which
 * keeps it out of access logs. "notfound" covers a share that is already gone
 * and a token that does not match; the server answers both alike.
 */
export async function revokeShare(
  slug: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<"deleted" | "notfound"> {
  const res = await fetchImpl(`/api/m/${encodeURIComponent(slug)}`, {
    method: "DELETE",
    headers: { "x-fd-manage-token": token },
  });
  if (res.status === 404) return "notfound";
  if (!res.ok) throw new Error(`revoke ${res.status}`);
  return "deleted";
}
