import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

test("展示版與配對、換輪使用相同的 12 個主題", async () => {
  const demo = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
  const first = demo.match(/const initialTopic\s*=\s*\{\s*topic:\s*"([^"]+)"/);
  const examples = demo.match(/const topics\s*=\s*\[([\s\S]*?)\n\s*\];/);
  assert.ok(first && examples, "找不到展示版主題庫");
  const demoTopics = [first[1], ...Array.from(examples[1].matchAll(/\btopic:\s*"([^"]+)"/g), match => match[1])];
  assert.equal(demoTopics.length, 12);
  assert.equal(new Set(demoTopics).size, demoTopics.length, "主題不可重複");
  for (const [backend, schema] of [["supabase", "public"], ["neon", "riddle_match"]]) {
    const migrationDir = new URL(`../${backend}/migrations/`, import.meta.url);
    const serverLists = new Map();
    const pattern = new RegExp(`create(?:\\s+or\\s+replace)?\\s+function\\s+${schema}\\.(join_matchmaking|start_next_round)\\s*\\([\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$;`, "gi");
    for (const file of (await readdir(migrationDir)).filter(name => name.endsWith(".sql")).sort()) {
      const migration = await readFile(new URL(file, migrationDir), "utf8");
      for (const match of migration.matchAll(pattern)) {
        const topics = match[2].match(/v_topics\s+text\[\]\s*:=\s*array\[([\s\S]*?)\];/);
        assert.ok(topics, `${file} 的 ${match[1]} 缺少主題清單`);
        serverLists.set(match[1].toLowerCase(), Array.from(topics[1].matchAll(/'([^']+)'/g), topic => topic[1]));
      }
    }
    assert.deepEqual([...serverLists.keys()].sort(), ["join_matchmaking", "start_next_round"], `${backend} 須檢查配對及換輪的最新主題庫`);
    for (const list of serverLists.values()) assert.deepEqual(list, demoTopics);
  }
});
