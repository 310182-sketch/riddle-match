(() => {
  const scriptUrl = document.currentScript.src;
  const config = window.RIDDLE_MATCH_SUPABASE_CONFIG || {};
  const isConfigured = Boolean(config.url && config.anonKey);

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
    if (!isConfigured) {
      if (config.url || config.anonKey) {
        window.RIDDLE_MATCH_BOOT_NOTICE = "Supabase 設定尚未填完整，目前先開啟展示模式。";
      }
      await loadScript("app.js");
      return;
    }

    try {
      await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js");
      if (!window.supabase?.createClient) throw new Error("Supabase client unavailable");
      window.RiddleMatchSupabase = window.supabase.createClient(config.url, config.anonKey);
      await loadScript("online.js");
    } catch (error) {
      console.error("Online mode could not start:", error);
      window.RIDDLE_MATCH_BOOT_NOTICE = "真人配對連線程式載入失敗，目前先開啟展示模式。";
      await loadScript("app.js");
    }
  }

  start();
})();
