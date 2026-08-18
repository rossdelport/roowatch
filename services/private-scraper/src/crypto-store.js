import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeKey(key) {
  if (!SAFE_KEY.test(key)) throw new TypeError("Encrypted store key is invalid");
}

export function encryptJson(value, key, aad) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const plaintext = Buffer.from(JSON.stringify(value));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}

export function decryptJson(envelope, key, aad) {
  if (!envelope || envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported encrypted file format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

async function atomicWrite(filePath, data, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  const directory = await open(path.dirname(filePath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class EncryptedJsonStore {
  constructor(directory, encryptionKey, purpose) {
    this.directory = directory;
    this.encryptionKey = encryptionKey;
    this.purpose = purpose;
  }

  filePath(key) {
    assertSafeKey(key);
    return path.join(this.directory, `${key}.enc.json`);
  }

  aad(key) {
    return `roowatch:${this.purpose}:${key}:v1`;
  }

  async write(key, value) {
    const envelope = encryptJson(value, this.encryptionKey, this.aad(key));
    await atomicWrite(this.filePath(key), `${JSON.stringify(envelope)}\n`);
    const info = await stat(this.filePath(key));
    return info.mtimeMs;
  }

  async read(key) {
    const envelope = JSON.parse(await readFile(this.filePath(key), "utf8"));
    return decryptJson(envelope, this.encryptionKey, this.aad(key));
  }

  async has(key) {
    try {
      await stat(this.filePath(key));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async updatedAtMs(key) {
    const info = await stat(this.filePath(key));
    return info.mtimeMs;
  }

  async keys() {
    try {
      return (await readdir(this.directory))
        .filter((name) => name.endsWith(".enc.json"))
        .map((name) => name.slice(0, -".enc.json".length))
        .filter((key) => SAFE_KEY.test(key));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async delete(key) {
    try {
      await unlink(this.filePath(key));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export { atomicWrite };
