import { readFile } from "node:fs/promises";
import { atomicWrite } from "./crypto-store.js";

const DEFAULT_STATE = Object.freeze({
  status: "error",
  sessionStatus: "stale",
  proxyStatus: "unknown",
  proxyFingerprint: "",
  latestErrorCode: "",
  latestError: ""
});

export class AccountStateStore {
  constructor(filePath, accounts) {
    this.filePath = filePath;
    this.accounts = accounts;
    this.state = new Map(accounts.map((account) => [account.id, { ...DEFAULT_STATE }]));
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      for (const account of this.accounts) {
        const saved = parsed.accounts?.[account.id];
        if (saved && typeof saved === "object") this.state.set(account.id, { ...DEFAULT_STATE, ...saved });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this;
  }

  get(accountId) {
    return { ...(this.state.get(accountId) || DEFAULT_STATE) };
  }

  async update(accountId, patch) {
    this.state.set(accountId, { ...this.get(accountId), ...patch });
    await this.save();
    return this.get(accountId);
  }

  async save() {
    const accounts = Object.fromEntries(this.state);
    await atomicWrite(this.filePath, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`);
  }

  heartbeatAccounts() {
    return this.accounts.map((account) => {
      const publicState = this.get(account.id);
      delete publicState.proxyFingerprint;
      return { id: account.id, label: account.label, ...publicState };
    });
  }
}
