Deno.env.set("SUPABASE_URL", "https://unit-test.supabase.co");
Deno.env.set("SUPABASE_ANON_KEY", "unit-test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "unit-test-service-key");
Deno.env.set("ALLOWED_ORIGINS", "https://game.example, http://localhost:8000");

const { handleRequest } = await import("./index.ts");

function assertEquals(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

function createRequest(method: string, origin: string) {
  return new Request("https://edge.example/functions/v1/delete-account", {
    method,
    headers: { origin },
  });
}

Deno.test("allows preflight for an explicitly configured origin", async () => {
  const response = await handleRequest(
    createRequest("OPTIONS", "https://game.example"),
  );
  assertEquals(response.status, 200, "status");
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://game.example",
    "allowed origin",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Methods"),
    "POST, OPTIONS",
    "allowed methods",
  );
});

Deno.test("rejects unlisted origins before processing a request", async () => {
  const response = await handleRequest(
    createRequest("POST", "https://attacker.example"),
  );
  assertEquals(response.status, 403, "status");
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    null,
    "CORS origin",
  );
});

Deno.test("rejects preflight requests from unlisted origins", async () => {
  const response = await handleRequest(
    createRequest("OPTIONS", "https://attacker.example"),
  );
  assertEquals(response.status, 403, "status");
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    null,
    "CORS origin",
  );
});

Deno.test("rejects methods other than POST", async () => {
  const response = await handleRequest(
    createRequest("GET", "https://game.example"),
  );
  assertEquals(response.status, 405, "status");
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://game.example",
    "CORS origin",
  );
});

Deno.test("requires a bearer token before creating an authenticated client", async () => {
  const response = await handleRequest(
    createRequest("POST", "https://game.example"),
  );
  assertEquals(response.status, 401, "status");
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://game.example",
    "CORS origin",
  );
});
