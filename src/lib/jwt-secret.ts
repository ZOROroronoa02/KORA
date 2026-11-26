/** Accept only canonical base64url secrets containing at least 256 random key bits. */
export function accessTokenSigningKey(secret: string | undefined): Uint8Array {
  if (!secret || !/^[A-Za-z0-9_-]{43,}$/.test(secret)) {
    throw new Error("JWT_ACCESS_SECRET must be a base64url-encoded random secret containing at least 32 bytes");
  }
  const key = Buffer.from(secret, "base64url");
  if (key.byteLength < 32 || key.toString("base64url") !== secret) {
    throw new Error("JWT_ACCESS_SECRET must be a canonical base64url-encoded random secret containing at least 32 bytes");
  }
  return key;
}
