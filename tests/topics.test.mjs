import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("展示版與配對、換輪使用相同的 12 個主題", async () => {
  const demo = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261126000000_initial_realtime_game.sql", import.meta.url), "utf8");
  const first = demo.match(/const initialTopic\s*=\s*\{\s*topic:\s*"([^"]+)"/);
  const examples = demo.match(/const topics\s*=\s*\[([\s\S]*?)\n\s*\];/);
  assert.ok(first && examples, "找不到展示版主題庫");
  const demoTopics = [first[1], ...Array.from(examples[1].matchAll(/\btopic:\s*"([^"]+)"/g), match => match[1])];
  const serverLists = Array.from(migration.matchAll(/v_topics\s+text\[\]\s*:=\s*array\[([\s\S]*?)\];/g), match =>
    Array.from(match[1].matchAll(/'([^']+)'/g), topic => topic[1]));

  assert.equal(demoTopics.length, 12);
  assert.equal(new Set(demoTopics).size, demoTopics.length, "主題不可重複");
  assert.equal(serverLists.length, 2, "須檢查配對及換輪的主題庫");
  for (const list of serverLists) assert.deepEqual(list, demoTopics);
});
