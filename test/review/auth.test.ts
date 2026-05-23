import { describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, hashSecret } from "../../src/review/auth.js";

describe("review auth helpers", () => {
  it("encrypts and decrypts stored OAuth tokens", () => {
    const ciphertext = encryptSecret("ghu_example", "32-byte-review-token-encryption-key");

    expect(ciphertext).not.toContain("ghu_example");
    expect(decryptSecret(ciphertext, "32-byte-review-token-encryption-key")).toBe("ghu_example");
  });

  it("binds session hashes to the configured secret", () => {
    expect(hashSecret("session", "first-secret")).not.toBe(hashSecret("session", "second-secret"));
  });
});
