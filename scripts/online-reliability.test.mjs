import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../site/online.js", import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
const defer = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

class Clock {
  now = 1_800_000_000_000;
  jobs = new Map();
  nextId = 0;
  set(fn, delay, repeat = false) {
    const id = ++this.nextId;
    this.jobs.set(id, { fn, at: this.now + delay, delay, repeat });
    return id;
  }
  clear(id) { this.jobs.delete(id); }
  async advance(ms) {
    const target = this.now + ms;
    while (true) {
      const entries = [...this.jobs.entries()].filter(([, job]) => job.at <= target);
      entries.sort((a, b) => a[1].at - b[1].at);
      if (!entries.length) break;
      const [id, job] = entries[0];
      this.now = job.at;
      if (job.repeat) job.at += job.delay;
      else this.jobs.delete(id);
      job.fn();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

class Element {
  constructor() {
    this.listeners = new Map();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.elements = {};
    this.inputs = [];
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    };
  }
  addEventListener(type, fn) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), fn]);
  }
  fire(type) {
    const event = { preventDefault() {}, currentTarget: this, target: this };
    return Promise.all((this.listeners.get(type) || []).map((fn) => fn(event)));
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  querySelectorAll() { return this.inputs; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function room(overrides = {}) {
  return {
    id: "room-1", player_one_id: "me", player_two_id: "peer",
    player_one_nickname: "我", player_two_nickname: "朋友", setter_id: "peer",
    round_number: 1, topic_number: 1, topic: "日常小物", riddle: null,
    status: "waiting_setter", hint_used: false, expires_at: null, ...overrides,
  };
}

async function setup() {
  const clock = new Clock();
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  get("#matching").classList.add("hidden");
  get("#game").classList.add("hidden");
  get("[data-nickname-form]").elements.nickname = new Element();
  get("[data-chat-form]").elements.message = new Element();
  get("[data-guess-form]").elements.answer = new Element();
  for (const name of ["riddle", "answer", "hint"]) get("[data-setter-form]").elements[name] = new Element();
  for (const form of ["[data-chat-form]", "[data-guess-form]", "[data-setter-form]"]) {
    get(form).inputs = [...Object.values(get(form).elements), new Element()];
  }

  const document = {
    querySelector(selector) {
      if (selector === "[data-next-round]") return get(".composer-area").children.find((child) => "nextRound" in child.dataset);
      return get(selector);
    },
    querySelectorAll(selector) { return [get(selector)]; },
    createElement() { return new Element(); },
    createTextNode(text) { const node = new Element(); node.textContent = text; return node; },
  };
  const backend = {
    room: room(), calls: [], channels: [], removed: [],
    rpc(name) {
      if (name === "join_matchmaking") return { data: { state: "matched", room_id: "room-1" }, error: null };
      if (name === "end_expired_round") return { data: { state: "active" }, error: null };
      return { data: true, error: null };
    },
    selectRoom() { return { data: { ...this.room }, error: null }; },
    selectMessages() { return { data: [], error: null }; },
    insertMessage(data) { return { data: { ...data, id: "message-1", created_at: "now" }, error: null }; },
  };
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: "me" } } }, error: null }) },
    rpc(name, args) { backend.calls.push({ name, args }); return Promise.resolve(backend.rpc(name, args)); },
    from(table) {
      const query = {
        filters: {}, inserted: null,
        select() { return this; },
        eq(key, value) { this.filters[key] = value; return this; },
        order() { return this; },
        insert(data) { this.inserted = data; return this; },
        single() {
          return Promise.resolve(this.inserted ? backend.insertMessage(this.inserted) : backend.selectRoom(this.filters));
        },
        then(resolve, reject) {
          return Promise.resolve(backend.selectMessages(this.filters)).then(resolve, reject);
        },
      };
      return query;
    },
    channel() {
      const channel = {
        handlers: [],
        on(_type, filter, handler) { this.handlers.push({ filter, handler }); return this; },
        subscribe(handler) { this.status = handler; return this; },
        update(data) { this.handlers.find(({ filter }) => filter.table === "match_rooms").handler({ new: data }); },
        message(data) { this.handlers.find(({ filter }) => filter.table === "room_messages").handler({ new: data }); },
      };
      backend.channels.push(channel);
      return channel;
    },
    removeChannel(channel) { backend.removed.push(channel); return Promise.resolve(); },
  };
  class FakeDate extends Date { static now() { return clock.now; } }
  const context = {
    window: { RiddleMatchSupabase: client, scrollTo() {} }, document, Date: FakeDate,
    setTimeout: (fn, delay) => clock.set(fn, delay), clearTimeout: (id) => clock.clear(id),
    setInterval: (fn, delay) => clock.set(fn, delay, true), clearInterval: (id) => clock.clear(id),
    console: { error() {} },
  };
  vm.runInNewContext(source, context, { filename: "online.js" });
  await flush();
  const start = async () => {
    get("[data-nickname-form]").elements.nickname.value = "我";
    await get("[data-nickname-form]").fire("submit");
    await flush();
  };
  return { backend, clock, get, start };
}

function visible(element) { return !element.classList.contains("hidden"); }
function content(element) { return [element.textContent, ...element.children.map(content)].join(" "); }

test("cancelling while matched room is loading waits for the join and never opens the room", async () => {
  const app = await setup();
  const loading = defer();
  app.backend.selectRoom = () => loading.promise;
  await app.start();
  const firstCancel = app.get("[data-cancel]").fire("click");
  const secondCancel = app.get("[data-cancel]").fire("click");
  loading.resolve({ data: room(), error: null });
  await flush();
  await app.clock.advance(25);
  await Promise.all([firstCancel, secondCancel]);
  assert.deepEqual(app.backend.calls.map(({ name }) => name), ["join_matchmaking", "cancel_matchmaking"]);
  assert.equal(app.backend.channels.length, 0);
  assert.equal(visible(app.get("#home")), true);
  assert.equal(visible(app.get("#game")), false);
});

test("a failed cancellation stays cancellable instead of silently rejoining", async () => {
  const app = await setup();
  app.backend.rpc = (name) => name === "join_matchmaking"
    ? { data: { state: "waiting" }, error: null }
    : { data: null, error: new Error("offline") };
  await app.start();
  await app.get("[data-cancel]").fire("click");
  assert.equal(visible(app.get("#matching")), true);
  assert.equal(app.get("[data-cancel]").disabled, false);
  assert.match(app.get("[data-match-caption]").textContent, /再試/);
  assert.deepEqual(app.backend.calls.map(({ name }) => name), ["join_matchmaking", "cancel_matchmaking"]);
});

test("reconnect refreshes room state and ignores late messages and events from older rounds", async () => {
  const app = await setup();
  const oldMessages = defer();
  app.backend.selectMessages = (filters) => filters.round_number === 1 ? oldMessages.promise : { data: [], error: null };
  await app.start();
  const channel = app.backend.channels[0];
  const roundTwo = room({ round_number: 2, topic: "第二題" });
  channel.update(roundTwo);
  oldMessages.resolve({ data: [{ id: "old", room_id: "room-1", round_number: 1, sender_id: "peer", body: "過期訊息" }], error: null });
  await flush();
  assert.doesNotMatch(content(app.get("[data-chat]")), /過期訊息/);
  app.backend.room = { ...roundTwo, status: "active", riddle: "同步後的謎題", expires_at: new Date(app.clock.now + 120_000).toISOString() };
  channel.status("SUBSCRIBED");
  await flush();
  assert.equal(app.get("[data-riddle]").textContent, "同步後的謎題");
  channel.update(room({ round_number: 1, status: "active", riddle: "舊題目" }));
  assert.equal(app.get("[data-riddle]").textContent, "同步後的謎題");
});

test("clock skew does not create a tight expiry loop and sends the expected round", async () => {
  const app = await setup();
  app.backend.room = room({ status: "active", expires_at: new Date(app.clock.now - 10_000).toISOString() });
  await app.start();
  const expiryCalls = () => app.backend.calls.filter(({ name }) => name === "end_expired_round");
  assert.equal(expiryCalls().length, 1);
  assert.equal(expiryCalls()[0].args.p_round_number, 1);
  await app.clock.advance(4_000);
  assert.equal(expiryCalls().length, 1);
  await app.clock.advance(1_000);
  assert.equal(expiryCalls().length, 2);
});

test("leaving errors keep the room open for retry; a successful retry removes the channel", async () => {
  const app = await setup();
  let failures = 1;
  const original = app.backend.rpc;
  app.backend.rpc = function(name, args) {
    if (name === "leave_room" && failures-- > 0) return { data: null, error: new Error("offline") };
    return original.call(this, name, args);
  };
  await app.start();
  await app.get("[data-home]").fire("click");
  assert.equal(visible(app.get("#game")), true);
  assert.equal(app.backend.removed.length, 0);
  await app.get("[data-home]").fire("click");
  assert.equal(visible(app.get("#home")), true);
  assert.equal(app.backend.removed.length, 1);
});

test("a pending chat insert cannot submit a guess after the player leaves", async () => {
  const app = await setup();
  const insertion = defer();
  app.backend.room = room({ status: "active", expires_at: new Date(app.clock.now + 120_000).toISOString() });
  app.backend.insertMessage = () => insertion.promise;
  await app.start();
  app.get("[data-guess-form]").elements.answer.value = "答案";
  const guess = app.get("[data-guess-form]").fire("submit");
  await flush();
  await app.get("[data-home]").fire("click");
  insertion.resolve({ data: { id: "late", room_id: "room-1", round_number: 1, sender_id: "me", body: "答案" }, error: null });
  await guess;
  assert.equal(app.backend.calls.some(({ name }) => name === "submit_guess"), false);
});

test("a pending chat insert cannot submit an old guess into a new round", async () => {
  const app = await setup();
  const insertion = defer();
  app.backend.room = room({ status: "active", expires_at: new Date(app.clock.now + 120_000).toISOString() });
  app.backend.insertMessage = () => insertion.promise;
  await app.start();
  app.get("[data-guess-form]").elements.answer.value = "答案";
  const guess = app.get("[data-guess-form]").fire("submit");
  await flush();
  app.backend.channels[0].update(room({ round_number: 2, topic: "新主題" }));
  insertion.resolve({ data: { id: "late", room_id: "room-1", round_number: 1, sender_id: "me", body: "答案" }, error: null });
  await guess;
  assert.equal(app.backend.calls.some(({ name }) => name === "submit_guess"), false);
  assert.doesNotMatch(content(app.get("[data-chat]")), /答案/);
});

test("all player operations send their original round number", async () => {
  const setter = await setup();
  setter.backend.room = room({ setter_id: "me", round_number: 7 });
  await setter.start();
  const fields = setter.get("[data-setter-form]").elements;
  fields.riddle.value = "謎題";
  fields.answer.value = "答案";
  fields.hint.value = "提示";
  await setter.get("[data-setter-form]").fire("submit");
  assert.equal(setter.backend.calls.find(({ name }) => name === "submit_riddle").args.p_round_number, 7);

  const guesser = await setup();
  guesser.backend.room = room({ round_number: 4, status: "active", expires_at: new Date(guesser.clock.now + 120_000).toISOString() });
  await guesser.start();
  guesser.get("[data-guess-form]").elements.answer.value = "答案";
  await guesser.get("[data-guess-form]").fire("submit");
  await guesser.get("[data-hint]").fire("click");
  assert.equal(guesser.backend.calls.find(({ name }) => name === "submit_guess").args.p_round_number, 4);
  assert.equal(guesser.backend.calls.find(({ name }) => name === "request_room_hint").args.p_round_number, 4);

  const completed = await setup();
  completed.backend.room = room({ round_number: 3, status: "solved" });
  await completed.start();
  await completed.get(".composer-area").children.find((child) => "nextRound" in child.dataset).fire("click");
  assert.equal(completed.backend.calls.find(({ name }) => name === "start_next_round").args.p_round_number, 3);
});

test("round_changed triggers a room refresh while a failed chat keeps the draft", async () => {
  const app = await setup();
  app.backend.room = room({ status: "active", round_number: 4, expires_at: new Date(app.clock.now + 120_000).toISOString() });
  const original = app.backend.rpc;
  app.backend.rpc = function(name, args) {
    if (name === "submit_guess") {
      this.room = room({ round_number: 5, topic: "新主題" });
      return { data: null, error: new Error("round_changed") };
    }
    return original.call(this, name, args);
  };
  await app.start();
  app.backend.insertMessage = () => ({ data: null, error: new Error("offline") });
  const message = app.get("[data-chat-form]").elements.message;
  message.value = "還沒送出去";
  await app.get("[data-chat-form]").fire("submit");
  assert.equal(message.value, "還沒送出去");
  app.get("[data-guess-form]").elements.answer.value = "答案";
  await app.get("[data-guess-form]").fire("submit");
  assert.equal(app.get("[data-round]").textContent, "05");
  assert.equal(app.backend.calls.find(({ name }) => name === "submit_guess").args.p_round_number, 4);
});
