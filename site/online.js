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
  let roomRevision = 0;
  let leavingRoom = false;
  let loadedRound = null;
  let latestStatusKey = "";
  let revealedRounds = new Set();
  let timeoutRetryAt = new Map();
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
    if (!message?.id || !currentRoom || message.room_id !== currentRoom.id ||
        message.round_number !== currentRoom.round_number || seenMessages.has(message.id)) return;
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
    if (currentRoom?.id !== roomId || currentRoom.round_number !== roundNumber) return;
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

  async function syncChangedRound(error, roomId) {
    if (!error?.message?.includes("round_changed")) return false;
    flash("回合已更新，正在同步最新狀態。");
    await refreshRoom(roomId);
    return true;
  }

  function startTimer(room) {
    stopTimer();
    const output = document.querySelector("[data-timer]");
    if (room.status !== "active" || !room.expires_at) {
      output.textContent = "05:00";
      return;
    }
    const tick = async () => {
      if (currentRoom?.id !== room.id || currentRoom.round_number !== room.round_number ||
          currentRoom.status !== "active") return;
      const milliseconds = Date.parse(room.expires_at) - Date.now();
      const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
      output.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
      if (seconds === 0) {
        await revealTimeout(room.id, room.round_number);
      }
    };
    timerId = setInterval(tick, 1000);
    tick();
  }

  async function revealTimeout(roomId, roundNumber) {
    const key = `${roomId}:${roundNumber}`;
    if (revealedRounds.has(key) || Date.now() < (timeoutRetryAt.get(key) || 0)) return;
    revealedRounds.add(key);
    const { data, error } = await client.rpc("end_expired_round", { p_room_id: roomId, p_round_number: roundNumber });
    if (currentRoom?.id !== roomId || currentRoom.round_number !== roundNumber) return;
    if (error) {
      revealedRounds.delete(key);
      timeoutRetryAt.set(key, Date.now() + 5000);
      if (await syncChangedRound(error, roomId)) return;
      console.error(error);
      flash("確認回合時間時發生問題，稍後會再試。");
      return;
    }
    if (data?.state === "timed_out" && data.answer) {
      addSystem(`時間到囉！這題的答案是「${data.answer}」。`);
    }
    if (data?.state === "active") {
      revealedRounds.delete(key);
      timeoutRetryAt.set(key, Date.now() + 5000);
      return;
    }
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
      if (!currentRoom || leavingRoom) return;
      const roomId = currentRoom.id;
      const roundNumber = currentRoom.round_number;
      button.disabled = true;
      const { error } = await client.rpc("start_next_round", { p_room_id: roomId, p_round_number: roundNumber });
      if (currentRoom?.id !== roomId || currentRoom.round_number !== roundNumber) return;
      if (error) {
        button.disabled = false;
        if (await syncChangedRound(error, roomId)) return;
        flash("目前無法開始下一輪，請等房間狀態同步後再試。");
        console.error(error);
      } else await refreshRoom(roomId);
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
    // A query or delayed event must not restore an earlier round or phase.
    const statusOrder = { waiting_setter: 0, active: 1, solved: 2, timed_out: 2, abandoned: 3 };
    if (room.round_number < currentRoom.round_number ||
        (room.round_number === currentRoom.round_number &&
          ((statusOrder[room.status] ?? -1) < (statusOrder[currentRoom.status] ?? -1) ||
           (currentRoom.hint_used && !room.hint_used)))) return;
    roomRevision += 1;
    const newRound = loadedRound !== room.round_number;
    currentRoom = room;
    const role = currentRole(room);
    const opponentName = room.player_one_id === authUser.id
      ? room.player_two_nickname : room.player_one_nickname;
    if (newRound) {
      loadedRound = room.round_number;
      seenMessages = new Set();
      chat.replaceChildren();
      chatForm.elements.message.value = "";
      guessForm.elements.answer.value = "";
      setterForm.elements.riddle.value = "";
      setterForm.elements.answer.value = "";
      setterForm.elements.hint.value = "";
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
    else {
      stopTimer();
      if (room.status === "waiting_setter") document.querySelector("[data-timer]").textContent = "05:00";
    }
    if (room.status === "timed_out") revealTimeout(room.id, room.round_number);
  }

  async function refreshRoom(roomId) {
    const revision = roomRevision;
    const { data, error } = await client.from("match_rooms").select("*").eq("id", roomId).single();
    if (currentRoom?.id !== roomId || roomRevision !== revision) return;
    if (error) {
      console.error(error);
      flash("無法同步房間，請檢查連線後再試。");
      return;
    }
    applyRoom(data);
  }

  async function openRoom(roomId, epoch) {
    const { data, error } = await client.from("match_rooms").select("*").eq("id", roomId).single();
    if (epoch !== matchmakingEpoch) return false;
    if (error) {
      console.error(error);
      flash("配對成功，但無法載入房間。請重新整理後再試。");
      showView("home");
      return false;
    }

    currentRoom = data;
    loadedRound = null;
    latestStatusKey = "";
    seenMessages = new Set();
    revealedRounds = new Set();
    timeoutRetryAt = new Map();
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
        if (currentRoom?.id !== roomId) return;
        if (status === "SUBSCRIBED") {
          // Realtime can miss updates while disconnected; reread both state and messages.
          refreshRoom(roomId).then(() => {
            if (currentRoom?.id === roomId) loadMessages(roomId, currentRoom.round_number);
          });
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          flash("即時同步中斷，請檢查網路連線。");
        }
      });

    if (data.status === "timed_out") revealTimeout(data.id, data.round_number);
    return true;
  }

  async function pollMatchmaking(epoch) {
    if (matchmakingBusy || epoch !== matchmakingEpoch) return;
    matchmakingBusy = true;
    try {
      const { data, error } = await client.rpc("join_matchmaking", { p_nickname: currentNickname });
      if (error) throw error;
      if (epoch !== matchmakingEpoch) {
        return;
      }
      if (data?.state === "matched") {
        clearInterval(matchmakingTimer);
        matchmakingTimer = undefined;
        document.querySelector("[data-match-caption]").textContent = "找到謎友了，正在準備房間…";
        document.querySelector("[data-match-status]").textContent = "找到謎友了，正在準備房間。";
        const opened = await openRoom(data.room_id, epoch);
        if (opened && epoch === matchmakingEpoch) matchmakingEpoch += 1;
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
    document.querySelector("[data-match-status]").textContent = "正在尋找一起猜謎的新朋友。";
    showView("matching");
    pollMatchmaking(epoch);
    matchmakingTimer = setInterval(() => {
      if (epoch !== matchmakingEpoch) return;
      const waitedSeconds = Math.floor((Date.now() - matchmakingStartedAt) / 1000);
      document.querySelector("[data-match-caption]").textContent = `已等待 ${Math.floor(waitedSeconds / 60)}:${String(waitedSeconds % 60).padStart(2, "0")}`;
      const continueButton = document.querySelector("[data-continue]");
      if (waitedSeconds >= 30 && continueButton.classList.contains("hidden")) {
        continueButton.classList.remove("hidden");
        document.querySelector("[data-match-status]").textContent = "已等待三十秒，可以選擇繼續等待或返回首頁。";
      }
      if (!matchmakingBusy) pollMatchmaking(epoch);
    }, 1000);
  }

  async function cancelMatchmaking() {
    if (cancelInProgress) return;
    cancelInProgress = true;
    matchmakingEpoch += 1;
    clearInterval(matchmakingTimer);
    matchmakingTimer = undefined;
    const cancelButton = document.querySelector("[data-cancel]");
    const restoreFocus = document.activeElement === cancelButton;
    cancelButton.disabled = true;
    document.querySelector("[data-continue]").classList.add("hidden");
    document.querySelector("[data-match-caption]").textContent = "正在取消配對，請稍候…";
    document.querySelector("[data-match-status]").textContent = "正在取消配對，請稍候。";
    try {
      // Wait for any in-flight join before cancelling, so a late join cannot requeue us.
      while (matchmakingBusy) await new Promise((resolve) => setTimeout(resolve, 25));
      const { error } = await client.rpc("cancel_matchmaking");
      if (error) throw error;
      showView("home");
    } catch (error) {
      console.error(error);
      document.querySelector("[data-match-caption]").textContent = "取消配對遇到問題，請檢查連線後再試。";
      flash("無法確認取消配對，請再試一次。");
    } finally {
      cancelInProgress = false;
      cancelButton.disabled = false;
      if (restoreFocus && !views.matching.classList.contains("hidden")) cancelButton.focus();
    }
  }

  async function sendChat(text) {
    const value = text.trim();
    if (!value || !currentRoom || leavingRoom || !["waiting_setter", "active"].includes(currentRoom.status)) return false;
    const { id: roomId, round_number: roundNumber } = currentRoom;
    const { data, error } = await client.from("room_messages").insert({
      room_id: roomId,
      round_number: roundNumber,
      sender_id: authUser.id,
      body: value,
    }).select("id, room_id, round_number, sender_id, body, created_at").single();
    if (currentRoom?.id !== roomId || currentRoom.round_number !== roundNumber) return false;
    if (error) {
      console.error(error);
      flash("訊息沒有送出，請檢查連線後再試。");
      return false;
    }
    renderMessage(data);
    return true;
  }

  async function returnHome() {
    if (leavingRoom) return;
    const room = currentRoom;
    if (!room) return;
    leavingRoom = true;
    try {
      const { error } = await client.rpc("leave_room", { p_room_id: room.id });
      if (error) throw error;
    } catch (error) {
      console.error(error);
      flash("目前無法離開房間，請檢查連線後再試。");
      leavingRoom = false;
      return;
    }
    stopTimer();
    const channel = roomChannel;
    roomChannel = undefined;
    currentRoom = undefined;
    loadedRound = null;
    latestStatusKey = "";
    leavingRoom = false;
    showView("home");
    if (channel) Promise.resolve(client.removeChannel(channel)).catch(console.error);
  }

  function bindEvents() {
    document.querySelectorAll("[data-start]").forEach((button) => button.addEventListener("click", () => {
      nicknameModal.showModal();
      nicknameField.focus();
    }));
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
      document.querySelector("[data-match-status]").textContent = "繼續尋找一起猜謎的新朋友。";
    });
    document.querySelectorAll("[data-home]").forEach((button) => button.addEventListener("click", (event) => {
      event.preventDefault();
      if (currentRoom) return returnHome();
      else if (!views.matching.classList.contains("hidden")) return cancelMatchmaking();
      else showView("home");
    }));
    document.querySelectorAll("[data-show-help]").forEach((button) => button.addEventListener("click", () => document.querySelector("[data-modal]").showModal()));
    document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => document.querySelector("[data-modal]").close()));
    document.querySelector("[data-modal]").addEventListener("click", (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });

    chatForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const field = chatForm.elements.message;
      const value = field.value;
      if (await sendChat(value) && field.value === value) field.value = "";
    });
    setterForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!currentRoom || leavingRoom) return;
      const { id: roomId, round_number: roundNumber } = currentRoom;
      const fields = setterForm.elements;
      const { error } = await client.rpc("submit_riddle", {
        p_room_id: roomId,
        p_round_number: roundNumber,
        p_riddle: fields.riddle.value.trim(),
        p_answer: fields.answer.value.trim(),
        p_hint: fields.hint.value.trim(),
        p_accepted_answers: [],
      });
      if (currentRoom?.id !== roomId || currentRoom.round_number !== roundNumber) return;
      if (error) {
        if (await syncChangedRound(error, roomId)) return;
        console.error(error);
        flash("謎題沒有送出，請確認欄位後再試。");
        return;
      }
      fields.riddle.value = "";
      fields.answer.value = "";
      fields.hint.value = "";
      await refreshRoom(roomId);
    });
    guessForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!currentRoom || leavingRoom) return;
      const { id: roomId, round_number: roundNumber } = currentRoom;
      const field = guessForm.elements.answer;
      const originalValue = field.value;
      const value = originalValue.trim();
      if (!value) return;
      await sendChat(`我猜是「${value}」！`);
      if (currentRoom?.id !== roomId || currentRoom.round_number !== roundNumber) return;
      const { data, error } = await client.rpc("submit_guess", { p_room_id: roomId, p_guess: value, p_round_number: roundNumber });
      if (currentRoom?.id !== roomId || currentRoom.round_number !== roundNumber) return;
      if (error) {
        if (await syncChangedRound(error, roomId)) return;
        console.error(error);
        flash("答案沒有送出，請稍後再試。");
        return;
      }
      if (field.value === originalValue) field.value = "";
      if (data?.state === "timed_out" && data.answer) {
        addSystem(`時間到囉！這題的答案是「${data.answer}」。`);
        await refreshRoom(roomId);
      } else if (data?.correct === false) {
        flash("還差一點點，可以再問問題或猜一次。");
      } else if (data?.correct === true) await refreshRoom(roomId);
    });
    hintButton.addEventListener("click", async () => {
      if (!currentRoom || leavingRoom) return;
      const { id: roomId, round_number: roundNumber } = currentRoom;
      const { data, error } = await client.rpc("request_room_hint", { p_room_id: roomId, p_round_number: roundNumber });
      if (currentRoom?.id !== roomId || currentRoom.round_number !== roundNumber) return;
      if (error) {
        if (await syncChangedRound(error, roomId)) return;
        console.error(error);
        flash(error.message?.includes("hint_already_used") ? "這個提示已經看過囉，再想想看！" : "目前無法取得提示。");
        return;
      }
      if (data) addSystem(`給你一點提示：${data}`);
      await refreshRoom(roomId);
    });
    reportButton.title = "玩家安全回報功能尚未上線";
    reportButton.addEventListener("click", () => flash("玩家安全回報功能尚未上線。"));
    document.querySelector("[data-block]").addEventListener("click", () => flash("這個連線模式尚未提供封鎖，您可以先離開這局。"));
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
