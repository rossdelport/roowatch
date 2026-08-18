import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ERROR_CODES, ScraperError } from "./errors.js";

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function acquireProcessLock(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const token = randomBytes(12).toString("hex");
  const body = JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(filePath, "wx", 0o600);
      await handle.writeFile(body);
      await handle.sync();
      return async () => {
        await handle.close();
        try {
          const current = JSON.parse(await readFile(filePath, "utf8"));
          if (current.token === token) await unlink(filePath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let existing;
      try {
        existing = JSON.parse(await readFile(filePath, "utf8"));
      } catch {
        existing = {};
      }
      if (processIsAlive(Number(existing.pid))) {
        throw new ScraperError(ERROR_CODES.OVERLAPPING_RUN, "Another private scraper process is already running");
      }
      await unlink(filePath);
    }
  }
  throw new ScraperError(ERROR_CODES.OVERLAPPING_RUN, "Could not acquire the private scraper process lock");
}
