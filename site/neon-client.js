(() => {
  const config = window.RIDDLE_MATCH_NEON_CONFIG || {};
  const base = new URL(config.functionUrl.endsWith("/") ? config.functionUrl : `${config.functionUrl}/`);
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) ||
      base.username || base.password || base.search || base.hash) {
    throw new Error("Neon function URL must be an HTTPS URL (or localhost HTTP) without credentials, query or fragment");
  }

  const sessionKey = "riddle-match-neon-session-v1";
  const contextKey = "riddle-match-neon-context-v1";
  let session;
  let memoryContext = {};
  let reportedExpiry = false;

  function read(key) {
    try { return JSON.parse(window.sessionStorage.getItem(key) || "null"); }
    catch (_) { return null; }
  }
  function write(key, value) {
    try {
      if (value == null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch (_) { /* Storage may be unavailable; the tab can still play without reload recovery. */ }
  }
  function saveContext(value) {
    memoryContext = { ...value };
    write(contextKey, memoryContext);
  }
  function getContext() {
    return read(contextKey) || memoryContext;
  }
  function clearSession() {
    session = undefined;
    write(sessionKey, null);
    saveContext({});
  }

  async function request(path, { method = "GET", body, authenticated = true, reportExpiry = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const requestToken = authenticated ? session?.token : undefined;
    try {
      const headers = { Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (requestToken) headers.Authorization = `Bearer ${requestToken}`;
      const response = await fetch(new URL(path, base), {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store", signal: controller.signal,
      });
      let payload;
      try { payload = await response.json(); } catch (_) { payload = {}; }
      if (!response.ok) {
        const error = new Error(payload.error?.code || "request_failed");
        error.code = payload.error?.code || "request_failed";
        error.status = response.status;
        // An old request can fail after a replacement session has already been issued.
        if (response.status === 401 && reportExpiry && requestToken && session?.token === requestToken && !reportedExpiry) {
          reportedExpiry = true;
          window.dispatchEvent(new Event("riddle-neon-session-expired"));
        }
        throw error;
      }
      return payload;
    } finally { clearTimeout(timer); }
  }

  async function createSession() {
    const data = await request("session", { method: "POST", body: {}, authenticated: false, reportExpiry: false });
    if (!data?.token || !data?.user_id || !data?.expires_at) throw new Error("invalid_session_response");
    session = { token: data.token, user_id: data.user_id, expires_at: data.expires_at };
    reportedExpiry = false;
    write(sessionKey, session);
    return session;
  }

  async function initialize() {
    let wasReset = false;
    session = read(sessionKey);
    if (session?.token && session?.user_id) {
      try {
        const data = await request("session", { reportExpiry: false });
        if (!data?.user_id || data.user_id !== session.user_id) throw new Error("invalid_session_response");
        session.expires_at = data.expires_at;
        write(sessionKey, session);
        return { user: { id: session.user_id }, wasReset };
      } catch (error) {
        if (error.status !== 401) throw error;
        clearSession();
        wasReset = true;
      }
    }
    const data = await createSession();
    return { user: { id: data.user_id }, wasReset };
  }

  async function rpc(name, params = {}) {
    try {
      const result = await request(`rpc/${encodeURIComponent(name)}`, { method: "POST", body: params });
      if (!Object.prototype.hasOwnProperty.call(result, "data")) throw new Error("invalid_rpc_response");
      return { data: result.data, error: null };
    } catch (error) { return { data: null, error }; }
  }

  window.RiddleMatchNeon = { initialize, createSession, clearSession, rpc, saveContext, getContext };
})();
