export class ResultOutbox {
  constructor(encryptedStore, apiClient, logger) {
    this.store = encryptedStore;
    this.apiClient = apiClient;
    this.logger = logger;
  }

  async enqueue(result) {
    // A retry must never replace the only durable copy of an earlier result.
    if (await this.store.has(result.runId)) return false;
    await this.store.write(result.runId, result);
    return true;
  }

  async flush() {
    const keys = await this.store.keys();
    let sent = 0;
    for (const key of keys.sort()) {
      const result = await this.store.read(key);
      await this.apiClient.submitResult(result);
      await this.store.delete(key);
      sent += 1;
      this.logger.info("result_delivered", { runId: result.runId, status: result.status });
    }
    return sent;
  }
}
