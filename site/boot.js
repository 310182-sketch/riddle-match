(() => {
  const scriptUrl = document.currentScript.src;
  const config = window.RIDDLE_MATCH_SUPABASE_CONFIG || {};
  const neonConfig = window.RIDDLE_MATCH_NEON_CONFIG || {};
  const isConfigured = Boolean(config.url && config.anonKey);
  const host = window.location.hostname.toLowerCase();
  const isLocalPreview = window.location.protocol === "file:" || host === "localhost" ||
    host.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(host) || host === "[::1]";
  const explicitlyOnline = new URLSearchParams(window.location.search).get("online") === "1";

  function loadScript(path) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL(path, scriptUrl).href;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Unable to load ${path}`));
      document.head.append(script);
    });
  }

  async function start() {
    // A published backend must not turn opening a local copy into a live game.
    if (isLocalPreview && !explicitlyOnline) {
      await loadScript("app.js?v=20261126-safety");
      return;
    }
    if (neonConfig.functionUrl) {
      try {
        await loadScript("neon-client.js");
        if (!window.RiddleMatchNeon) throw new Error("Neon client unavailable");
        await loadScript("neon-online.js?v=20261126-accessibility");
      } catch (error) {
        console.error("Neon mode could not start:", error);
        window.RIDDLE_MATCH_BOOT_NOTICE = "真人配對連線程式載入失敗，目前先開啟展示模式。";
        await loadScript("app.js?v=20261126-safety");
      }
      return;
    }
    if (!isConfigured) {
      if (config.url || config.anonKey) {
        window.RIDDLE_MATCH_BOOT_NOTICE = "Supabase 設定尚未填完整，目前先開啟展示模式。";
      } else if (isLocalPreview && explicitlyOnline) {
        window.RIDDLE_MATCH_BOOT_NOTICE = "尚未設定真人配對後端，目前先開啟展示模式。";
      }
      await loadScript("app.js?v=20261126-safety");
      return;
    }

    try {
      await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js");
      if (!window.supabase?.createClient) throw new Error("Supabase client unavailable");
      window.RiddleMatchSupabase = window.supabase.createClient(config.url, config.anonKey);
      await loadScript("online.js?v=20261126-accessibility");
    } catch (error) {
      console.error("Online mode could not start:", error);
      window.RIDDLE_MATCH_BOOT_NOTICE = "真人配對連線程式載入失敗，目前先開啟展示模式。";
      await loadScript("app.js?v=20261126-safety");
    }
  }

  start();
})();
