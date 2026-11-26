(() => {
  const client = window.RiddleMatchSupabase;
  const views = {
    home: document.querySelector("#home"),
    matching: document.querySelector("#matching"),
    game: document.querySelector("#game"),
  };
  const chat = document.querySelector("[data-chat]");
  const toast = document.querySelector("[data-toast]");
  const chatForm = document.querySelector("[data-chat-form]");
  const guessForm = document.querySelector("[data-guess-form]");
  const setterForm = document.querySelector("[data-setter-form]");
  const nicknameModal = document.querySelector("[data-nickname-modal]");
  const nicknameForm = document.querySelector("[data-nickname-form]");
  const nicknameField = nicknameForm.elements.nickname;
  const reportButton = document.querySelector("[data-report]");
  const hintButton = document.querySelector("[data-hint]");
  const modeLabel = document.querySelector("[data-mode-label]");
  let toastTimer;
  let timerId;
  let matchmakingTimer;
  let matchmakingEpoch = 0;
  let matchmakingStartedAt = 0;
  let matchmakingBusy = false;
  let cancelInProgress = false;
  let authUser;
  let currentNickname = "";
  let currentRoom;
  let roomChannel;
  let loadedRound = null;
  let latestStatusKey = "";
  let revealedRounds = new Set();
  let seenMessages = new Set();

  function showView(name) {
    Object.entries(views).forEach(([key, element]) => element.classList.toggle("hidden", key !== name));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function flash(message) {
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 3000);
  }

  function addSystem(text) {
    const item = document.createElement("div");
    item.className = "message-system";
    item.textContent = text;
    chat.append(item);
    chat.scrollTop = chat.scrollHeight;
  }

  function renderMessage(message) {
    if (!message?.id || seenMessages.has(message.id)) return;
    seenMessages.add(message.id);
    const mine = message.sender_id === authUser.id;
    const name = mine ? "你" : (currentRoom?.player_one_id === message.sender_id
      ? currentRoom.player_one_nickname : currentRoom?.player_two_nickname) || "謎友";
    const row = document.createElement("div");
    row.className = `chat-message ${mine ? "mine" : "theirs"}`;
    const avatar = document.createElement("span");
    avatar.className = `avatar ${mine ? "avatar-blue" : "avatar-orange"}`;
    avatar.textContent = mine ? (currentNickname[0] || "你") : (name[0] || "謎");
    const content = document.createElement("div");
    content.className = "message-content";
    const label = document.createElement("span");
    label.className = "message-name";
    label.textContent = name;
    const bubble = document.createElement("span");
    bubble.className = "message-text";
    bubble.textContent = message.body;
    content.append(label, bubble);
    row.append(avatar, content);
    chat.append(row);
    chat.scrollTop = chat.scrollHeight;
  }

  async function loadMessages(roomId, roundNumber) {
    const { data, error } = await client.from("room_messages")
      .select("id, room_id, round_number, sender_id, body, created_at")
      .eq("room_id", roomId)
      .eq("round_number", roundNumber)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (error) {
      flash("無法載入聊天室訊息，請稍後重試。");
      console.error(error);
      return;
    }
    data.forEach(renderMessage);
  }

  function currentRole(room = currentRoom) {
    return room?.setter_id === authUser.id ? "setter" : "guesser";
  }

  function stopTimer() {
    clearInterval(timerId);
    timerId = undefined;
  }

  function startTimer(room) {
    stopTimer();
    const output = document.querySelector("[data-timer]");
    if (room.status !== "active" || !room.expires_at) {
      output.textContent = "05:00";
      return;
    }
    const tick = async () => {
      const milliseconds = Date.parse(room.expires_at) - Date.now();
      const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
      output.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
      if (seconds === 0) {
        stopTimer();
        await revealTimeout(room.id, room.round_number);
      }
    };
    tick();
    timerId = setInterval(tick, 1000);
  }

  async function revealTimeout(roomId, roundNumber) {
    const key = `${roomId}:${roundNumber}`;
    if (revealedRounds.has(key)) return;
    revealedRounds.add(key);
    const { data, error } = await client.rpc("end_expired_round", { p_room_id: roomId });
    if (error) {
      revealedRounds.delete(key);
      console.error(error);
      flash("確認回合時間時發生問題，正在重新同步。");
      await refreshRoom(roomId);
      return;
    }
    if (data?.state === "timed_out" && data.answer) {
      addSystem(`時間到囉！這題的答案是「${data.answer}」。`);
    }
    if (data?.state === "active") revealedRounds.delete(key);
    await refreshRoom(roomId);
  }

  function showNextRound() {
    document.querySelector("[data-next-round]")?.remove();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary-button next-round-button";
    button.dataset.nextRound = "";
    button.textContent = "交換角色，開始下一輪 ↗";
    button.style.cssText = "margin: 11px auto 0; display:flex; height:38px; min-width:0; font-size:9px; justify-content:center;";
    button.addEventListener("click", async () => {
      button.disabled = true;
      const { error } = await client.rpc("start_next_round", { p_room_id: currentRoom.id });
      if (error) {
        button.disabled = false;
        flash("目前無法開始下一輪，請等房間狀態同步後再試。");
        console.error(error);
      }
    });
    document.querySelector(".composer-area").append(button);
  }

  function showReturnHome() {
    document.querySelector("[data-next-round]")?.remove();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary-button";
    button.textContent = "返回首頁";
    button.style.cssText = "margin: 11px auto 0; display:flex; height:38px; min-width:0; font-size:9px; justify-content:center;";
    button.addEventListener("click", returnHome);
    document.querySelector(".composer-area").append(button);
  }

  function applyRoom(room) {
    if (!room || room.id !== currentRoom?.id) return;
    const newRound = loadedRound !== room.round_number;
    currentRoom = room;
    const role = currentRole(room);
    const opponentName = room.player_one_id === authUser.id
      ? room.player_two_nickname : room.player_one_nickname;
    if (newRound) {
      loadedRound = room.round_number;
      seenMessages = new Set();
      chat.replaceChildren();
      if (room.round_number === 1) addSystem("配對成功！保持友善，祝你們玩得開心。");
      else addSystem("新一輪開始囉，雙方已交換角色。");
      loadMessages(room.id, room.round_number);
    }

    document.querySelector("[data-round]").textContent = String(room.round_number).padStart(2, "0");
    document.querySelector("[data-topic]").textContent = room.topic;
    document.querySelector("[data-topic-number]").textContent = String(room.topic_number);
    document.querySelector("[data-you-avatar]").textContent = currentNickname[0] || "你";
    document.querySelector("[data-opponent-avatar]").textContent = opponentName[0] || "謎";
    document.querySelector("[data-opponent-name]").textContent = opponentName;
    document.querySelector("[data-you-role]").textContent = role === "setter" ? "出題者" : "猜題者";
    document.querySelector("[data-opponent-role]").textContent = role === "setter" ? "猜題者" : "出題者";
    document.querySelector("[data-riddle-label]").textContent = role === "setter" ? "你要出的謎題" : "對方的謎題";
    document.querySelector("[data-riddle]").textContent = room.riddle || (role === "setter"
      ? "先想一個符合主題的謎題，再傳給對方開始猜。"
      : "出題者正在準備謎題，稍等一下就可以開始猜了。");
    document.querySelector("[data-riddle-help]").textContent = role === "setter"
      ? "謎題不要直接說出答案，並準備一個可索取的提示。"
      : "自由提問，找出答案；也可以直接猜。";

    const isWaitingSetter = room.status === "waiting_setter";
    const isActive = room.status === "active";
    const isSetter = role === "setter";
    const isGuesser = role === "guesser";
    setterForm.classList.toggle("hidden", !isSetter || !isWaitingSetter);
    chatForm.classList.toggle("hidden", !["waiting_setter", "active"].includes(room.status));
    guessForm.classList.toggle("hidden", !isGuesser || !isActive);
    hintButton.classList.toggle("hidden", !isGuesser || !isActive);
    hintButton.disabled = room.hint_used;
    setterForm.elements.hint.required = true;
    const composersLocked = !["waiting_setter", "active"].includes(room.status);
    chatForm.querySelectorAll("input, button").forEach((element) => { element.disabled = composersLocked; });
    guessForm.querySelectorAll("input, button").forEach((element) => { element.disabled = !isActive; });
    setterForm.querySelectorAll("input, button").forEach((element) => { element.disabled = !isWaitingSetter; });

    const statusKey = `${room.round_number}:${room.status}`;
    if (statusKey !== latestStatusKey) {
      latestStatusKey = statusKey;
      if (room.status === "solved") {
        addSystem("猜謎成功！雙方可以交換角色並開始新主題。");
        showNextRound();
      } else if (room.status === "timed_out") {
        addSystem("本輪時間已結束，可以開始下一輪。");
        showNextRound();
      } else if (room.status === "abandoned") {
        addSystem("對方已離開這局。你可以返回首頁，再尋找一位謎友。");
        showReturnHome();
      } else {
        document.querySelector("[data-next-round]")?.remove();
      }
    }

    if (room.status === "active") startTimer(room);
    else stopTimer();
    if (room.status === "timed_out") revealTimeout(room.id, room.round_number);
  }

  async function refreshRoom(roomId) {
    const { data, error } = await client.from("match_rooms").select("*").eq("id", roomId).single();
    if (error) {
      console.error(error);
      return;
    }
    applyRoom(data);
  }

  async function openRoom(roomId) {
    const { data, error } = await client.from("match_rooms").select("*").eq("id", roomId).single();
    if (error) {
      console.error(error);
      flash("配對成功，但無法載入房間。請重新整理後再試。");
      showView("home");
      return;
    }

    currentRoom = data;
    loadedRound = null;
    latestStatusKey = "";
    seenMessages = new Set();
    revealedRounds = new Set();
    chat.replaceChildren();
    showView("game");
    applyRoom(data);

    roomChannel = client.channel(`room-${roomId}`)
      .on("postgres_changes", {
        event: "UPDATE", schema: "public", table: "match_rooms", filter: `id=eq.${roomId}`,
      }, (payload) => applyRoom(payload.new))
      .on("postgres_changes", {
        event: "INSERT", schema: "public", table: "room_messages", filter: `room_id=eq.${roomId}`,
      }, (payload) => {
        if (payload.new.round_number === currentRoom?.round_number) renderMessage(payload.new);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") loadMessages(roomId, currentRoom?.round_number);
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          flash("即時同步中斷，請檢查網路連線。");
        }
      });

    if (data.status === "timed_out") revealTimeout(data.id, data.round_number);
  }

  async function pollMatchmaking(epoch) {
    if (matchmakingBusy || epoch !== matchmakingEpoch) return;
    matchmakingBusy = true;
    try {
      const { data, error } = await client.rpc("join_matchmaking", { p_nickname: currentNickname });
      if (error) throw error;
      if (epoch !== matchmakingEpoch) {
        if (cancelInProgress && data?.state === "matched") {
          await client.rpc("leave_room", { p_room_id: data.room_id });
        }
        return;
      }
      if (data?.state === "matched") {
        matchmakingEpoch += 1;
        clearInterval(matchmakingTimer);
        matchmakingTimer = undefined;
        document.querySelector("[data-match-caption]").textContent = "找到謎友了，正在準備房間…";
        await openRoom(data.room_id);
      } else {
        document.querySelector("[data-match-caption]").textContent = "正在尋找一起猜謎的新朋友…";
      }
    } catch (error) {
      console.error(error);
      if (epoch === matchmakingEpoch) {
        clearInterval(matchmakingTimer);
        matchmakingTimer = undefined;
        document.querySelector("[data-match-caption]").textContent = "連線遇到問題，請返回首頁後重試。";
        flash("無法加入配對，請稍後再試。");
      }
    } finally {
      matchmakingBusy = false;
    }
  }

  function startMatchmaking(nickname) {
    currentNickname = nickname.trim();
    matchmakingStartedAt = Date.now();
    cancelInProgress = false;
    const epoch = ++matchmakingEpoch;
    nicknameModal.close();
    document.querySelector("[data-continue]").classList.add("hidden");
    document.querySelector("[data-match-caption]").textContent = "正在尋找一起猜謎的新朋友…";
    showView("matching");
    pollMatchmaking(epoch);
    matchmakingTimer = setInterval(() => {
      if (epoch !== matchmakingEpoch) return;
      const waitedSeconds = Math.floor((Date.now() - matchmakingStartedAt) / 1000);
      document.querySelector("[data-match-caption]").textContent = `已等待 ${Math.floor(waitedSeconds / 60)}:${String(waitedSeconds % 60).padStart(2, "0")}`;
      if (waitedSeconds >= 30) document.querySelector("[data-continue]").classList.remove("hidden");
      if (!matchmakingBusy) pollMatchmaking(epoch);
    }, 1000);
  }

  async function cancelMatchmaking() {
    cancelInProgress = true;
    matchmakingEpoch += 1;
    clearInterval(matchmakingTimer);
    matchmakingTimer = undefined;
    while (matchmakingBusy) await new Promise((resolve) => setTimeout(resolve, 25));
    const { error } = await client.rpc("cancel_matchmaking");
    if (error) {
      console.error(error);
      cancelInProgress = false;
      flash("取消配對時發生問題，正在重新嘗試配對。");
      startMatchmaking(currentNickname);
      return;
    }
    cancelInProgress = false;
    showView("home");
  }

  async function sendChat(text) {
    const value = text.trim();
    if (!value || !currentRoom || !["waiting_setter", "active"].includes(currentRoom.status)) return;
    const { data, error } = await client.from("room_messages").insert({
      room_id: currentRoom.id,
      round_number: currentRoom.round_number,
      sender_id: authUser.id,
      body: value,
    }).select("id, room_id, round_number, sender_id, body, created_at").single();
    if (error) {
      console.error(error);
      flash("訊息沒有送出，請檢查連線後再試。");
      return;
    }
    renderMessage(data);
  }

  async function returnHome() {
    const room = currentRoom;
    stopTimer();
    if (room) {
      await client.rpc("leave_room", { p_room_id: room.id });
    }
    if (roomChannel) {
      await client.removeChannel(roomChannel);
      roomChannel = undefined;
    }
    currentRoom = undefined;
    loadedRound = null;
    latestStatusKey = "";
    showView("home");
  }

  function bindEvents() {
    document.querySelectorAll("[data-start]").forEach((button) => button.addEventListener("click", () => nicknameModal.showModal()));
    document.querySelector("[data-close-nickname]").addEventListener("click", () => nicknameModal.close());
    nicknameModal.addEventListener("click", (event) => { if (event.target === nicknameModal) nicknameModal.close(); });
    nicknameForm.addEventListener("submit", (event) => {
      event.preventDefault();
      startMatchmaking(nicknameField.value);
    });
    document.querySelector("[data-cancel]").addEventListener("click", cancelMatchmaking);
    document.querySelector("[data-continue]").addEventListener("click", () => {
      matchmakingStartedAt = Date.now();
      document.querySelector("[data-continue]").classList.add("hidden");
      document.querySelector("[data-match-caption]").textContent = "繼續尋找一起猜謎的新朋友…";
    });
    document.querySelectorAll("[data-home]").forEach((button) => button.addEventListener("click", (event) => {
      event.preventDefault();
      if (currentRoom) returnHome();
      else if (!views.matching.classList.contains("hidden")) cancelMatchmaking();
      else showView("home");
    }));
    document.querySelectorAll("[data-show-help]").forEach((button) => button.addEventListener("click", () => document.querySelector("[data-modal]").showModal()));
    document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => document.querySelector("[data-modal]").close()));
    document.querySelector("[data-modal]").addEventListener("click", (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });

    chatForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const field = chatForm.elements.message;
      const value = field.value;
      field.value = "";
      await sendChat(value);
    });
    setterForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!currentRoom) return;
      const fields = setterForm.elements;
      const { error } = await client.rpc("submit_riddle", {
        p_room_id: currentRoom.id,
        p_riddle: fields.riddle.value.trim(),
        p_answer: fields.answer.value.trim(),
        p_hint: fields.hint.value.trim(),
        p_accepted_answers: [],
      });
      if (error) {
        console.error(error);
        flash("謎題沒有送出，請確認欄位後再試。");
        return;
      }
      fields.riddle.value = "";
      fields.answer.value = "";
      fields.hint.value = "";
    });
    guessForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!currentRoom) return;
      const field = guessForm.elements.answer;
      const value = field.value.trim();
      if (!value) return;
      await sendChat(`我猜是「${value}」！`);
      const { data, error } = await client.rpc("submit_guess", { p_room_id: currentRoom.id, p_guess: value });
      field.value = "";
      if (error) {
        console.error(error);
        flash("答案沒有送出，請稍後再試。");
      } else if (data?.state === "timed_out" && data.answer) {
        addSystem(`時間到囉！這題的答案是「${data.answer}」。`);
        await refreshRoom(currentRoom.id);
      } else if (data?.correct === false) {
        flash("還差一點點，可以再問問題或猜一次。");
      }
    });
    hintButton.addEventListener("click", async () => {
      if (!currentRoom) return;
      const { data, error } = await client.rpc("request_room_hint", { p_room_id: currentRoom.id });
      if (error) {
        console.error(error);
        flash(error.message?.includes("hint_already_used") ? "這個提示已經看過囉，再想想看！" : "目前無法取得提示。");
        return;
      }
      if (data) addSystem(`給你一點提示：${data}`);
      else await refreshRoom(currentRoom.id);
    });
    reportButton.disabled = true;
    reportButton.title = "玩家安全回報功能尚未上線";
    reportButton.addEventListener("click", () => flash("玩家安全回報功能尚未上線。"));
  }

  async function initialize() {
    modeLabel.replaceChildren();
    const dot = document.createElement("span");
    dot.className = "pulse-dot";
    modeLabel.append(dot, document.createTextNode("真人配對"));
    document.querySelector(".demo-disclaimer").innerHTML = '<span class="pulse-dot"></span> 真人配對：房間與聊天由 Supabase 同步，請保持友善。';
    bindEvents();
    document.querySelectorAll("[data-start]").forEach((button) => { button.disabled = true; });
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw sessionError;
    let user = sessionData.session?.user;
    if (!user) {
      const { data, error } = await client.auth.signInAnonymously();
      if (error) throw error;
      user = data.user;
    }
    authUser = user;
    document.querySelectorAll("[data-start]").forEach((button) => { button.disabled = false; });
  }

  initialize().catch((error) => {
    console.error("Supabase setup failed:", error);
    flash("真人配對服務暫時無法連線，請稍後再試。");
    document.querySelector("[data-match-caption]").textContent = "配對服務連線失敗，請重新整理後再試。";
  });
})();
