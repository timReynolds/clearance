import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { ClearanceDatabase } from "../db/index.js";
import { reviewSessions, reviewUserTokens, reviewUsers } from "../db/schema.js";

export type ReviewAuthenticatedUser = {
  accessToken?: string;
  avatarUrl?: string;
  id: string;
  login: string;
};

export type ReviewAuthOptions = {
  sessionSecret: string;
  tokenEncryptionKey: string;
};

export type ReviewTokenInput = {
  accessToken: string;
  avatarUrl?: string;
  expiresAt?: string;
  githubLogin: string;
  githubUserId?: number;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  scopes?: string[];
};

export type ReviewSessionInput = {
  csrfToken: string;
  expiresAt: string;
  sessionToken: string;
  userId: string;
};

export class DrizzleReviewAuthStore {
  constructor(
    private readonly db: ClearanceDatabase,
    private readonly options: ReviewAuthOptions,
  ) {}

  async upsertUserToken(input: ReviewTokenInput): Promise<ReviewAuthenticatedUser> {
    return this.db.transaction(async (tx) => {
      const users = await tx
        .insert(reviewUsers)
        .values({
          avatarUrl: input.avatarUrl,
          githubLogin: input.githubLogin,
          githubUserId: input.githubUserId,
        })
        .onConflictDoUpdate({
          set: {
            avatarUrl: input.avatarUrl,
            githubUserId: input.githubUserId,
            updatedAt: new Date().toISOString(),
          },
          target: reviewUsers.githubLogin,
        })
        .returning({
          avatarUrl: reviewUsers.avatarUrl,
          githubLogin: reviewUsers.githubLogin,
          id: reviewUsers.id,
        });
      const user = users[0];
      if (user === undefined) {
        throw new Error("failed to persist review user");
      }

      await tx
        .insert(reviewUserTokens)
        .values({
          accessTokenCiphertext: encryptSecret(input.accessToken, this.options.tokenEncryptionKey),
          expiresAt: input.expiresAt,
          refreshTokenCiphertext:
            input.refreshToken === undefined
              ? undefined
              : encryptSecret(input.refreshToken, this.options.tokenEncryptionKey),
          refreshTokenExpiresAt: input.refreshTokenExpiresAt,
          scopes: input.scopes ?? [],
          userId: user.id,
        })
        .onConflictDoUpdate({
          set: {
            accessTokenCiphertext: encryptSecret(
              input.accessToken,
              this.options.tokenEncryptionKey,
            ),
            expiresAt: input.expiresAt ?? null,
            refreshTokenCiphertext:
              input.refreshToken === undefined
                ? null
                : encryptSecret(input.refreshToken, this.options.tokenEncryptionKey),
            refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
            scopes: input.scopes ?? [],
            updatedAt: new Date().toISOString(),
          },
          target: reviewUserTokens.userId,
        });

      return {
        accessToken: input.accessToken,
        avatarUrl: user.avatarUrl ?? undefined,
        id: user.id,
        login: user.githubLogin,
      };
    });
  }

  async createSession(input: ReviewSessionInput): Promise<void> {
    await this.db.insert(reviewSessions).values({
      csrfTokenHash: hashSecret(input.csrfToken, this.options.sessionSecret),
      expiresAt: input.expiresAt,
      sessionTokenHash: hashSecret(input.sessionToken, this.options.sessionSecret),
      userId: input.userId,
    });
  }

  async loadSession(sessionToken: string): Promise<ReviewAuthenticatedUser | undefined> {
    const rows = await this.db
      .select({
        accessTokenCiphertext: reviewUserTokens.accessTokenCiphertext,
        avatarUrl: reviewUsers.avatarUrl,
        expiresAt: reviewSessions.expiresAt,
        id: reviewUsers.id,
        login: reviewUsers.githubLogin,
      })
      .from(reviewSessions)
      .innerJoin(reviewUsers, eq(reviewSessions.userId, reviewUsers.id))
      .leftJoin(reviewUserTokens, eq(reviewUserTokens.userId, reviewUsers.id))
      .where(
        eq(reviewSessions.sessionTokenHash, hashSecret(sessionToken, this.options.sessionSecret)),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined || Date.parse(row.expiresAt) <= Date.now()) {
      return undefined;
    }

    await this.db
      .update(reviewSessions)
      .set({ lastSeenAt: new Date().toISOString() })
      .where(
        eq(reviewSessions.sessionTokenHash, hashSecret(sessionToken, this.options.sessionSecret)),
      );

    return {
      accessToken:
        row.accessTokenCiphertext === null
          ? undefined
          : decryptSecret(row.accessTokenCiphertext, this.options.tokenEncryptionKey),
      avatarUrl: row.avatarUrl ?? undefined,
      id: row.id,
      login: row.login,
    };
  }

  async deleteSession(sessionToken: string): Promise<void> {
    await this.db
      .delete(reviewSessions)
      .where(
        eq(reviewSessions.sessionTokenHash, hashSecret(sessionToken, this.options.sessionSecret)),
      );
  }

  async deleteUserTokens(githubLogin: string): Promise<void> {
    const users = await this.db
      .select({ id: reviewUsers.id })
      .from(reviewUsers)
      .where(eq(reviewUsers.githubLogin, githubLogin))
      .limit(1);
    const user = users[0];
    if (user === undefined) {
      return;
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(reviewUserTokens).where(eq(reviewUserTokens.userId, user.id));
      await tx.delete(reviewSessions).where(eq(reviewSessions.userId, user.id));
    });
  }

  async verifyCsrf(input: { csrfToken: string; sessionToken: string }): Promise<boolean> {
    const rows = await this.db
      .select({ csrfTokenHash: reviewSessions.csrfTokenHash })
      .from(reviewSessions)
      .where(
        and(
          eq(
            reviewSessions.sessionTokenHash,
            hashSecret(input.sessionToken, this.options.sessionSecret),
          ),
          eq(reviewSessions.csrfTokenHash, hashSecret(input.csrfToken, this.options.sessionSecret)),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return false;
    }

    return safeEqual(row.csrfTokenHash, hashSecret(input.csrfToken, this.options.sessionSecret));
  }
}

export function createRandomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSecret(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function encryptSecret(value: string, keyMaterial: string): string {
  const key = deriveEncryptionKey(keyMaterial);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

export function decryptSecret(value: string, keyMaterial: string): string {
  const [version, ivSource, tagSource, encryptedSource] = value.split(":");
  if (
    version !== "v1" ||
    ivSource === undefined ||
    tagSource === undefined ||
    encryptedSource === undefined
  ) {
    throw new Error("unsupported encrypted secret format");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveEncryptionKey(keyMaterial),
    Buffer.from(ivSource, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagSource, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedSource, "base64url")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

function deriveEncryptionKey(keyMaterial: string): Buffer {
  return createHash("sha256").update(keyMaterial).digest();
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
