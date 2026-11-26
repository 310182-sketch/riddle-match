import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../site/boot.js", import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

async function boot(url, { neon = "https://example.test/function", supabase = {} } = {}) {
  const loaded = [];
  const window = {
    location: new URL(url),
    RIDDLE_MATCH_NEON_CONFIG: { functionUrl: neon },
    RIDDLE_MATCH_SUPABASE_CONFIG: supabase,
  };
  const document = {
    currentScript: { src: new URL("boot.js", url).href },
    createElement: () => ({}),
    head: { append(script) {
      loaded.push(new URL(script.src).pathname.split("/").at(-1));
      if (loaded.at(-1) === "neon-client.js") window.RiddleMatchNeon = {};
      queueMicrotask(() => script.onload());
    } },
  };
  vm.runInNewContext(source, { window, document, URL, URLSearchParams, console: { error() {} } });
  await flush();
  return { loaded, notice: window.RIDDLE_MATCH_BOOT_NOTICE };
}

test("已設定真人後端時，本機與 file 預設仍是展示模式", async () => {
  for (const url of ["file:///C:/site/index.html", "http://localhost:4173/", "http://127.0.0.1:4173/", "http://127.0.0.2:4173/", "http://[::1]:4173/", "http://preview.localhost:4173/"]) {
    assert.deepEqual((await boot(url)).loaded, ["app.js"], url);
  }
});

test("本機必須明確啟用 online=1 才載入真人程式", async () => {
  assert.deepEqual((await boot("http://localhost:4173/?online=1")).loaded, ["neon-client.js", "neon-online.js"]);
  assert.deepEqual((await boot("http://localhost:4173/?online=0")).loaded, ["app.js"]);
  const unconfigured = await boot("http://localhost:4173/?online=1", { neon: "" });
  assert.deepEqual(unconfigured.loaded, ["app.js"]);
  assert.match(unconfigured.notice, /尚未設定真人配對後端/);
});

test("正式 Pages 依公開後端設定載入真人模式，未設定時展示", async () => {
  assert.deepEqual((await boot("https://310182-sketch.github.io/riddle-match/")).loaded, ["neon-client.js", "neon-online.js"]);
  assert.deepEqual((await boot("https://310182-sketch.github.io/riddle-match/", { neon: "" })).loaded, ["app.js"]);
});
