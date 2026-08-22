import crypto from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function decodeKey(keyMaterial) {
  if (Buffer.isBuffer(keyMaterial)) {
    if (keyMaterial.length !== 32) throw new RangeError("encryption key must be 32 bytes");
    return keyMaterial;
  }

  const raw = String(keyMaterial || "").trim();
  if (!raw) throw new TypeError("encryption key is required");

  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new RangeError("encryption key must decode to 32 bytes");
  return key;
}

function aadBuffer(aad) {
  return Buffer.from(String(aad || ""), "utf8");
}

export function encryptCredential(plaintext, keyMaterial, { aad = "" } = {}) {
  const value = String(plaintext || "");
  if (!value) throw new TypeError("credential plaintext is required");

  const key = decodeKey(keyMaterial);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadBuffer(aad));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptCredential(envelope, keyMaterial, { aad = "" } = {}) {
  const [version, ivText, tagText, ciphertextText, ...rest] = String(envelope || "").split(".");
  if (rest.length || version !== VERSION || !ivText || !tagText || !ciphertextText) {
    throw new TypeError("invalid credential envelope");
  }

  const key = decodeKey(keyMaterial);
  const iv = Buffer.from(ivText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  const ciphertext = Buffer.from(ciphertextText, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new TypeError("invalid credential envelope");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aadBuffer(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
