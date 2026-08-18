export function loadLocalEnv(file = ".env") {
  if (typeof process.loadEnvFile !== "function") return;
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
