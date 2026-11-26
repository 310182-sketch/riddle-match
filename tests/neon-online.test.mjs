import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../site/neon-online.js", import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); };
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

class Clock {
  now = 1_800_000_000_000;
  jobs = new Map(); nextId = 0;
  set(fn, delay, repeat = false) { const id = ++this.nextId; this.jobs.set(id, { fn, at: this.now + delay, delay, repeat }); return id; }
  clear(id) { this.jobs.delete(id); }
  async advance(ms) {
    const target = this.now + ms;
    while (true) {
      const entries = [...this.jobs.entries()].filter(([, job]) => job.at <= target).sort((a,b) => a[1].at - b[1].at);
      if (!entries.length) break;
      const [id, job] = entries[0]; this.now = job.at;
      if (job.repeat) job.at += job.delay; else this.jobs.delete(id);
      job.fn(); await flush();
    }
    this.now = target; await flush();
  }
}
class Element {
  constructor() {
    this.listeners = new Map(); this.children = []; this.dataset = {}; this.style = {}; this.elements = {}; this.inputs = [];
    this.textContent = ""; this.value = ""; this.disabled = false; this.open = false;
    const classes = new Set();
    this.classList = { add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)),
      contains: (name) => classes.has(name), toggle: (name, force) => { const enabled = force === undefined ? !classes.has(name) : force; if (enabled) classes.add(name); else classes.delete(name); return enabled; } };
  }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  fire(type) { const e = { preventDefault() {}, currentTarget: this, target: this }; return Promise.all((this.listeners.get(type) || []).map(fn => fn(e))); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  querySelector() { return null; }
  querySelectorAll() { return this.inputs; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const room = (overrides = {}) => ({ id: "room-1", player_one_id: "me", player_two_id: "peer", player_one_nickname: "我", player_two_nickname: "朋友", setter_id: "peer", round_number: 1, topic_number: 1, topic: "日常小物", riddle: "題目", status: "active", hint_used: false, expires_at: "2027-01-15T09:00:00Z", ...overrides });

async function setup({ initialRoom = room(), restored = true, reducedMotion = false } = {}) {
  const clock = new Clock(), elements = new Map(), scrolls = [];
  const get = (selector) => { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector); };
  get("#matching").classList.add("hidden"); get("#game").classList.add("hidden");
  get("[data-nickname-form]").elements.nickname = new Element();
  get("[data-chat-form]").elements.message = new Element(); get("[data-guess-form]").elements.answer = new Element();
  for (const name of ["riddle", "answer", "hint"]) get("[data-setter-form]").elements[name] = new Element();
  for (const form of ["[data-chat-form]", "[data-guess-form]", "[data-setter-form]"]) get(form).inputs = [...Object.values(get(form).elements), new Element()];
  const document = {
    querySelector(selector) { return selector === "[data-next-round]" ? get(".composer-area").children.find(child => "nextRound" in child.dataset) : get(selector); },
    querySelectorAll(selector) { return [get(selector)]; }, createElement() { return new Element(); }, createTextNode(text) { const n = new Element(); n.textContent = text; return n; },
  };
  const backend = { room: initialRoom, calls: [], rpc(name) {
    if (name === "get_room") return { data: { ...this.room }, error: null };
    if (name === "get_room_messages") return { data: [], error: null };
    if (name === "join_matchmaking") return { data: { state: "matched", room_id: this.room.id }, error: null };
    if (name === "request_room_hint") return { data: "可以遮雨", error: null };
    if (name === "end_expired_round") return { data: { state: "active" }, error: null };
    return { data: true, error: null };
  } };
  let saved = restored ? { nickname: "我", roomId: initialRoom.id } : {};
  const client = {
    initialize: async () => ({ user: { id: "me" }, wasReset: false }),
    getContext: () => saved, saveContext: (value) => { saved = value; }, clearSession() { saved = {}; },
    createSession: async () => ({ user_id: "new" }),
    rpc(name, args) { backend.calls.push({ name, args }); return Promise.resolve(backend.rpc(name, args)); },
  };
  class FakeDate extends Date { static now() { return clock.now; } }
  const window = { RiddleMatchNeon: client, scrollTo: value => scrolls.push(value), matchMedia: () => ({ matches: reducedMotion }), addEventListener() {} };
  vm.runInNewContext(source, { window, document, Date: FakeDate, setTimeout: (fn, ms) => clock.set(fn, ms), clearTimeout: id => clock.clear(id), setInterval: (fn, ms) => clock.set(fn, ms, true), clearInterval: id => clock.clear(id), console: { error() {} } });
  await flush();
  return { backend, client, clock, get, document, scrolls };
}
const content = (element) => [element.textContent, ...element.children.map(content)].join(" ");

test("已使用提示在刷新後仍可重看", async () => {
  const app = await setup({ initialRoom: room({ hint_used: true }) });
  assert.equal(app.get("[data-hint]").disabled, false);
  assert.equal(app.get("[data-hint]").textContent, "再次查看提示");
  await app.get("[data-hint]").fire("click"); await flush();
  assert.match(content(app.get("[data-chat]")), /可以遮雨/);
  assert.equal(app.backend.calls.filter(c => c.name === "request_room_hint").length, 1);
});

test("離開時延遲回覆不能繼續送出答案", async () => {
  const app = await setup();
  const sending = defer(), leaving = defer(), original = app.backend.rpc;
  app.backend.rpc = function(name, args) {
    if (name === "send_room_message") return sending.promise;
    if (name === "leave_room") return leaving.promise;
    return original.call(this, name, args);
  };
  app.get("[data-guess-form]").elements.answer.value = "雨傘";
  const guess = app.get("[data-guess-form]").fire("submit");
  const leave = app.get("[data-home]").fire("click");
  sending.resolve({ data: { id: "m", room_id: "room-1", round_number: 1, sender_id: "me", body: "雨傘" }, error: null });
  await flush();
  assert.equal(app.backend.calls.some(c => c.name === "submit_guess"), false);
  leaving.resolve({ data: true, error: null }); await Promise.all([guess, leave]);
  assert.equal(app.get("#home").classList.contains("hidden"), false);
});

test("上一間房的返回首頁按鈕不會殘留於新房間", async () => {
  const app = await setup({ initialRoom: room({ status: "abandoned" }) });
  const oldButton = app.document.querySelector("[data-next-round]");
  assert.equal(oldButton.textContent, "返回首頁");
  await oldButton.fire("click");
  app.backend.room = room({ id: "room-2", status: "waiting_setter", riddle: null });
  app.get("[data-nickname-form]").elements.nickname.value = "我";
  await app.get("[data-nickname-form]").fire("submit"); await flush();
  assert.equal(app.document.querySelector("[data-next-round]"), undefined);
  assert.equal(app.get("#game").classList.contains("hidden"), false);
});

test("減少動態效果設定會使用無動畫捲動", async () => {
  const app = await setup({ reducedMotion: true });
  assert.equal(app.scrolls.length > 0, true);
  assert.equal(app.scrolls.every(value => value.behavior === "auto"), true);
});

test("封鎖確認可取消，確認後只傳房間 ID 並返回首頁", async () => {
  const app = await setup();
  const original = app.backend.rpc;
  app.backend.rpc = function(name, args) {
    return name === "block_opponent" ? { data: { state: "blocked" }, error: null } : original.call(this, name, args);
  };
  await app.get("[data-block]").fire("click");
  assert.equal(app.get("[data-block-modal]").open, true);
  await app.get("[data-cancel-block]").fire("click");
  assert.equal(app.get("[data-block-modal]").open, false);
  assert.equal(app.backend.calls.some(call => call.name === "block_opponent"), false);
  await app.get("[data-block]").fire("click");
  await app.get("[data-confirm-block]").fire("click");
  const call = app.backend.calls.find(item => item.name === "block_opponent");
  assert.equal(call.args.p_room_id, "room-1");
  assert.deepEqual(Object.keys(call.args), ["p_room_id"]);
  assert.equal(app.backend.calls.some(item => item.name === "leave_room"), false);
  assert.equal(app.get("[data-block-modal]").open, false);
  assert.equal(app.get("#home").classList.contains("hidden"), false);
  assert.match(app.get("[data-toast]").textContent, /已封鎖/);
  assert.equal(app.client.getContext().roomId, undefined);
});

test("封鎖失敗保留對話框並能重試；傳送期間鎖住其他操作", async () => {
  const app = await setup();
  const pending = defer(), original = app.backend.rpc;
  let attempt = 0;
  app.backend.rpc = function(name, args) {
    if (name !== "block_opponent") return original.call(this, name, args);
    return ++attempt === 1 ? pending.promise : { data: { state: "blocked" }, error: null };
  };
  await app.get("[data-block]").fire("click");
  const operation = app.get("[data-confirm-block]").fire("click");
  assert.equal(app.get("[data-confirm-block]").disabled, true);
  assert.equal(app.get("[data-cancel-block]").disabled, true);
  await app.get("[data-cancel-block]").fire("click");
  assert.equal(app.get("[data-block-modal]").open, true);
  await app.get("[data-home]").fire("click");
  assert.equal(app.backend.calls.some(item => item.name === "leave_room"), false);
  pending.resolve({ data: null, error: new Error("offline") });
  await operation;
  assert.match(app.get("[data-block-error]").textContent, /再試/);
  assert.equal(app.get("[data-confirm-block]").disabled, false);
  assert.equal(app.get("#game").classList.contains("hidden"), false);
  await app.get("[data-confirm-block]").fire("click");
  assert.equal(app.get("#home").classList.contains("hidden"), false);
  assert.equal(attempt, 2);
});
