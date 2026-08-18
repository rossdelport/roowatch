import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, proxyForAccount } from "../src/config.js";

function baseEnv() {
  return {
    PRIVATE_SCRAPER_API_BASE_URL: "https://roowatch.example",
    PRIVATE_SCRAPER_SECRET: "s".repeat(40),
    PRIVATE_SCRAPER_WORKER_ID: "worker-1",
    SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    RESIDENTIAL_PROXY_PROVIDER: "contracted-provider",
    RESIDENTIAL_PROXY_SERVER_TEMPLATE: "http://proxy.example:8000",
    RESIDENTIAL_PROXY_USERNAME_TEMPLATE: "zone-session-{sessionId}",
    RESIDENTIAL_PROXY_PASSWORD_TEMPLATE: "private-password",
    PROXY_HEALTHCHECK_URL: "https://proxy-check.example/ip",
    PROXY_COST_CURRENCY: "AUD",
    PROXY_COST_MICROS_PER_GB: "1500000",
    VPS_COST_AUD_MICROS_PER_CHECK: "2000"
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "roowatch-config-"));
  await writeFile(path.join(directory, "accounts.json"), JSON.stringify([{
    id: "account-1",
    label: "Account 1",
    storageKey: "account-1",
    proxySessionId: "sticky-1"
  }]));
  return directory;
}

test("loads an account-sticky residential proxy configuration", async () => {
  const directory = await fixture();
  const config = await loadConfig(baseEnv(), directory);
  assert.equal(config.accounts.length, 1);
  assert.equal(config.bandwidthTargetBytes, 1_000_000);
  assert.equal(config.maxTransferBytes, 2_000_000);
  assert.equal(config.maxResultPayloadBytes, 500_000);
  assert.deepEqual(proxyForAccount(config, config.accounts[0]), {
    server: "http://proxy.example:8000",
    username: "zone-session-sticky-1",
    password: "private-password"
  });
});

test("rejects a proxy configuration with no stable per-account session", async () => {
  const directory = await fixture();
  const env = baseEnv();
  env.RESIDENTIAL_PROXY_USERNAME_TEMPLATE = "zone-with-rotating-ip";
  await assert.rejects(() => loadConfig(env, directory), /\{sessionId\}/);
});

test("rejects an unlabelled supplier cost", async () => {
  const directory = await fixture();
  const env = baseEnv();
  delete env.PROXY_COST_MICROS_PER_GB;
  await assert.rejects(() => loadConfig(env, directory), /PROXY_COST_MICROS_PER_GB is required/);
});

test("requires a positive proxy charge component and a positive VPS allocation", async () => {
  const directory = await fixture();

  const freeProxy = baseEnv();
  freeProxy.PROXY_COST_MICROS_PER_GB = "0";
  freeProxy.PROXY_FIXED_MICROS_PER_CHECK = "0";
  await assert.rejects(() => loadConfig(freeProxy, directory), /proxy cost component must be greater than zero/);

  const noVpsCost = baseEnv();
  noVpsCost.VPS_COST_AUD_MICROS_PER_CHECK = "0";
  await assert.rejects(() => loadConfig(noVpsCost, directory), /VPS_COST_AUD_MICROS_PER_CHECK is outside/);
});

test("allows zero per-GB proxy cost for a measured flat plan", async () => {
  const directory = await fixture();
  const env = baseEnv();
  env.PROXY_COST_MICROS_PER_GB = "0";
  env.PROXY_FIXED_MICROS_PER_CHECK = "2500";
  const config = await loadConfig(env, directory);
  assert.equal(config.proxyCostMicrosPerGb, 0);
  assert.equal(config.proxyFixedMicrosPerCheck, 2500);
});

test("requires HTTPS for a remote Worker API", async () => {
  const directory = await fixture();
  const env = baseEnv();
  env.PRIVATE_SCRAPER_API_BASE_URL = "http://roowatch.example";
  await assert.rejects(() => loadConfig(env, directory), /must use HTTPS/);
});

test("requires an independent HTTPS proxy health endpoint", async () => {
  const directory = await fixture();
  const insecure = baseEnv();
  insecure.PROXY_HEALTHCHECK_URL = "http://proxy-check.example/ip";
  await assert.rejects(() => loadConfig(insecure, directory), /must use HTTPS/);

  const facebook = baseEnv();
  facebook.PROXY_HEALTHCHECK_URL = "https://www.facebook.com/";
  await assert.rejects(() => loadConfig(facebook, directory), /must be independent/);
});

test("rejects configured costs that cannot remain exact integers", async () => {
  const directory = await fixture();
  const env = baseEnv();
  env.PROXY_FIXED_MICROS_PER_CHECK = String(Number.MAX_SAFE_INTEGER);
  await assert.rejects(() => loadConfig(env, directory), /exceeds exact integer range/);
});
