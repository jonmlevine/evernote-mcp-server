import assert from "node:assert/strict";
import test from "node:test";

import { EvernoteClient, isNoteStoreAuthExpiredResponse } from "../src/client.js";
import type { ApiResponse, AuthTokens } from "../src/types.js";

const tokens: AuthTokens = {
  jwt: "jwt-token",
  refreshToken: "refresh-token",
  legacyToken: "legacy-token",
  userId: "123",
  shard: "s123",
  expiresAt: Date.now() + 3_600_000,
  clientId: "evernote-web-client",
  redirectUri: "https://www.evernote.com/",
};

const authExpiredResponse: ApiResponse<unknown> = {
  ok: false,
  status: 500,
  error: "EDAMUserException: AUTH_EXPIRED (9); parameter=authenticationToken",
};

test("detects expired NoteStore authentication token responses", () => {
  assert.equal(isNoteStoreAuthExpiredResponse(authExpiredResponse), true);
  assert.equal(
    isNoteStoreAuthExpiredResponse({
      ok: false,
      status: 500,
      error: "EDAMUserException: BAD_DATA_FORMAT (2); parameter=filter",
    }),
    false
  );
});

test("refreshes and retries once when NoteStore auth expires", async () => {
  let refreshCount = 0;
  let saveCount = 0;
  let attempts = 0;

  const client = new EvernoteClient(tokens, "/tmp/tokens.json", {
    refreshTokens: async () => {
      refreshCount += 1;
      return { ...tokens, jwt: "new-jwt-token", legacyToken: "new-legacy-token" };
    },
    saveTokens: async (refreshedTokens, path) => {
      saveCount += 1;
      assert.equal(path, "/tmp/tokens.json");
      assert.equal(refreshedTokens.legacyToken, "new-legacy-token");
    },
  });

  const harness = client as unknown as {
    noteStoreRequest<T>(operation: () => Promise<ApiResponse<T>>): Promise<ApiResponse<T>>;
  };

  const result = await harness.noteStoreRequest(async () => {
    attempts += 1;
    if (attempts === 1) return authExpiredResponse as ApiResponse<string>;
    return { ok: true, status: 200, data: "retried" };
  });

  assert.deepEqual(result, { ok: true, status: 200, data: "retried" });
  assert.equal(attempts, 2);
  assert.equal(refreshCount, 1);
  assert.equal(saveCount, 1);
});
