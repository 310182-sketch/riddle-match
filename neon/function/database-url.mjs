// Apply the same certificate and hostname verification to both Neon URLs.
// Never put the original URL, which contains credentials, in an error message.
export function verifiedDatabaseUrl(value) {
  if (typeof value !== "string" || !value) throw new Error("Database URL is required");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid database URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
    throw new Error("Invalid database URL");
  }
  // set() also removes duplicate sslmode parameters; all other Neon options
  // (such as channel_binding) and the credentials remain in memory only.
  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

export function pooledDatabaseUrl(env) {
  return env.DATABASE_URL ? verifiedDatabaseUrl(env.DATABASE_URL) : undefined;
}
