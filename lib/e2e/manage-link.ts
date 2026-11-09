// The management link lets the uploader delete a share before it expires. Its
// token is made here and rides in the link's fragment like the content key;
// the server stores only base64url(SHA-256(token)), so neither it nor a copy
// of its database can delete a share. The crypto worker hashes it, because
// crypto.subtle is missing on plain HTTP.

import { toBase64url } from "./base64";
import type { Client } from "./v2/protocol";

/** The secret of a management link and the hash finalize stores. */
export interface ManageToken {
  token: string;
  hash: string;
}

/** Returns a new token of 32 random bytes as unpadded base64url, and its hash. */
export async function createManageToken(worker: Client): Promise<ManageToken> {
  const token = toBase64url(crypto.getRandomValues(new Uint8Array(32)));
  const { hash } = await worker.request({ op: "hash-token", token });
  return { token, hash };
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
