(() => {
  const views = {
    home: document.querySelector("#home"),
    matching: document.querySelector("#matching"),
    game: document.querySelector("#game"),
  };
  const modal = document.querySelector("[data-modal]");
  const chat = document.querySelector("[data-chat]");
  const toast = document.querySelector("[data-toast]");
  const chatForm = document.querySelector("[data-chat-form]");
  const guessForm = document.querySelector("[data-guess-form]");
  const setterForm = document.querySelector("[data-setter-form]");
  let timerId;
  let toastId;
  let round = 1;
  let topicNumber = 1;
  let role = "guesser";
  let hintUsed = false;
  let solved = false;
  let secondsLeft = 299;
  let pendingMatch;
  const initialTopic = { topic: "日常小物", answer: "雨傘", riddle: "我出門時常常帶著它，下雨的時候就會派上用場。", hint: "下雨天常常會帶著它出門。" };
  const topics = [
    { topic: "城市角落", answer: "公車站", riddle: "人們在這裡短暫相遇，等一個會載著大家往前走的東西。", hint: "常常可以在路邊看到它。" },
    { topic: "餐桌風景", answer: "筷子", riddle: "我成雙出現，陪人們把一頓飯好好吃完。", hint: "吃中式料理時很常用到。" },
    { topic: "午後時光", answer: "咖啡", riddle: "有人喜歡我苦一點，有人加奶加糖；一個小杯子就能讓午後醒過來。", hint: "很多人早上也會喝它。" },
    { topic: "自然觀察", answer: "彩虹", riddle: "雨停以後，我偶爾掛在天邊，穿著好幾種顏色。", hint: "要有陽光和水氣才容易看見。" },
    { topic: "居家日常", answer: "冰箱", riddle: "我住在廚房，肚子裡裝著各種食物，總是比房間涼快。", hint: "打開門會看到飲料和食材。" },
    { topic: "旅行途中", answer: "行李箱", riddle: "每次出遠門，我就跟著你一起裝下幾天的生活。", hint: "通常有輪子，可以拖著走。" },
    { topic: "天氣心情", answer: "風箏", riddle: "我在地上有人牽著，到了有風的日子就能飛上天空。", hint: "它有一條長長的線。" },
    { topic: "書桌一角", answer: "橡皮擦", riddle: "鉛筆寫錯的時候，我可以把痕跡慢慢帶走。", hint: "上學時常常會放在鉛筆盒裡。" },
    { topic: "夜晚抬頭", answer: "月亮", riddle: "白天不一定看得見，晚上常在天空陪著星星。", hint: "農曆十五前後看起來比較圓。" },
    { topic: "小小植物", answer: "仙人掌", riddle: "我長在乾燥的地方，身上有刺，卻不用常常喝水。", hint: "它是一種很耐旱的植物。" },
    { topic: "聲音記憶", answer: "鬧鐘", riddle: "每天早上，我用聲音提醒你：新的一天開始了。", hint: "很多人會把它放在床邊。" },
  ];
  let current = initialTopic;

  function showView(name) {
    Object.entries(views).forEach(([key, element]) => element.classList.toggle("hidden", key !== name));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function flash(message) {
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastId);
    toastId = setTimeout(() => toast.classList.remove("visible"), 2500);
  }

  function start() {
    clearTimeout(pendingMatch);
    clearInterval(timerId);
    role = Math.random() < 0.5 ? "guesser" : "setter";
    round = 1;
    topicNumber = 1;
    showView("matching");
    pendingMatch = setTimeout(() => beginRound(), 1450);
  }

  function beginRound() {
    const template = round === 1 && role === "guesser" ? initialTopic : topics[(topicNumber - 1) % topics.length];
    current = { ...template };
    if (role === "setter") current.answer = "";
    hintUsed = false;
    solved = false;
    secondsLeft = 299;
    document.querySelector("[data-next-round]")?.remove();
    setterForm.elements.riddle.value = "";
    setterForm.elements.answer.value = "";
    chatForm.elements.message.disabled = false;
    chatForm.querySelector("button").disabled = false;
    guessForm.elements.answer.disabled = false;
    guessForm.querySelector("button").disabled = false;
    setterForm.querySelectorAll("input, button").forEach((element) => { element.disabled = false; });
    document.querySelector("[data-hint]").disabled = false;
    document.querySelector("[data-round]").textContent = String(round).padStart(2, "0");
    document.querySelector("[data-topic]").textContent = current.topic;
    document.querySelector("[data-topic-number]").textContent = String(topicNumber);
    document.querySelector("[data-you-role]").textContent = role === "guesser" ? "猜題者" : "出題者";
    document.querySelector("[data-opponent-role]").textContent = `${role === "guesser" ? "出題者" : "猜題者"} · 示範`;
    document.querySelector("[data-riddle-label]").textContent = role === "guesser" ? "對方的謎題" : "你要出的謎題";
    document.querySelector("[data-riddle]").textContent = role === "guesser" ? current.riddle : "先想一個符合主題的謎題，再傳給對方開始猜。";
    document.querySelector("[data-riddle-help]").textContent = role === "guesser" ? "自由提問，找出答案；也可以直接猜。" : "謎題不要直接說出答案，讓對方有線索可以推理。";
    document.querySelector("[data-hint]").classList.toggle("hidden", role !== "guesser");
    guessForm.classList.toggle("hidden", role !== "guesser");
    setterForm.classList.toggle("hidden", role !== "setter");
    chatForm.classList.toggle("hidden", role === "setter");
    chat.replaceChildren();
    showView("game");
    if (role === "guesser") {
      addSystem("你已配對成功！這是一位示範玩家。自由提問或直接猜答案吧。");
      addMessage("opponent", "小島", "小", "avatar-orange", "準備好了，來猜猜看吧！");
    } else {
      addSystem("角色交換成功！請出一道符合主題的謎題，讓對方來猜。");
      addMessage("opponent", "小島", "小", "avatar-orange", "我準備好要猜了，出題給我吧！");
    }
    startTimer();
  }

  function addSystem(text) {
    const item = document.createElement("div");
    item.className = "message-system";
    item.textContent = text;
    chat.append(item);
    chat.scrollTop = chat.scrollHeight;
  }

  function addMessage(who, name, initial, avatarClass, text) {
    const row = document.createElement("div");
    row.className = `chat-message ${who === "you" ? "mine" : "theirs"}`;
    const avatar = document.createElement("span");
    avatar.className = `avatar ${avatarClass}`;
    avatar.textContent = initial;
    const content = document.createElement("div");
    content.className = "message-content";
    const label = document.createElement("span");
    label.className = "message-name";
    label.textContent = who === "you" ? "你" : name;
    const bubble = document.createElement("span");
    bubble.className = "message-text";
    bubble.textContent = text;
    content.append(label, bubble);
    row.append(avatar, content);
    chat.append(row);
    chat.scrollTop = chat.scrollHeight;
  }

  function startTimer() {
    const output = document.querySelector("[data-timer]");
    clearInterval(timerId);
    timerId = setInterval(() => {
      secondsLeft -= 1;
      output.textContent = `${String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:${String(secondsLeft % 60).padStart(2, "0")}`;
      if (secondsLeft <= 0) {
        clearInterval(timerId);
        finishByTimeout();
      }
    }, 1000);
  }

  function finishByTimeout() {
    const reveal = role === "guesser"
      ? `時間到囉！這題的答案是「${current.answer}」。下一輪交換角色。`
      : current.answer
        ? `時間到囉！示範玩家還沒猜中，這題的答案是「${current.answer}」。下一輪交換角色。`
        : "時間到囉！本輪還沒完成出題，下一輪直接交換角色。";
    addMessage("opponent", "小島", "小", "avatar-orange", reveal);
    addSystem("本輪結束，按下方按鈕交換角色並開始新主題。");
    showNextRound();
  }

  function normalize(text) {
    return text.toLocaleLowerCase().replace(/[\s，。！？、,.!?]/g, "");
  }

  const acceptedAnswers = {
    "雨傘": ["雨傘", "傘", "洋傘", "陽傘"],
    "公車站": ["公車站", "公車站牌", "站牌", "巴士站"],
    "筷子": ["筷子"], "咖啡": ["咖啡"], "彩虹": ["彩虹"],
    "冰箱": ["冰箱", "電冰箱", "雪櫃"], "行李箱": ["行李箱", "旅行箱"],
    "風箏": ["風箏"], "橡皮擦": ["橡皮擦", "橡皮"], "月亮": ["月亮", "月球"],
    "仙人掌": ["仙人掌"], "鬧鐘": ["鬧鐘", "時鐘"],
  };

  function submitGuess(raw) {
    const value = raw.trim();
    if (!value || solved) return;
    addMessage("you", "你", "你", "avatar-blue", `我猜是「${value}」！`);
    const choices = acceptedAnswers[current.answer] || [current.answer];
    const correct = choices.some((answer) => normalize(answer) === normalize(value));
    setTimeout(() => {
      if (correct) {
        solved = true;
        clearInterval(timerId);
        addMessage("opponent", "小島", "小", "avatar-orange", `答對了！答案就是${current.answer}，太厲害了！`);
        addSystem("猜謎成功！交換角色，再開始新一輪吧。題目結果只在這台瀏覽器模擬。");
        showNextRound();
      } else {
        addMessage("opponent", "小島", "小", "avatar-orange", "還差一點點！可以再問我一個問題，或再猜一次。" );
      }
    }, 420);
  }

  function showNextRound({ lockInputs = true } = {}) {
    const existing = document.querySelector("[data-next-round]");
    if (existing) existing.remove();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary-button next-round-button";
    button.dataset.nextRound = "";
    button.textContent = role === "setter" ? "結束出題，交換角色 ↗" : "交換角色，開始下一輪 ↗";
    button.style.cssText = "margin: 11px auto 0; display:flex; height:38px; min-width:0; font-size:9px; justify-content:center;";
    button.addEventListener("click", () => {
      round += 1;
      topicNumber = topicNumber % 12 + 1;
      role = role === "guesser" ? "setter" : "guesser";
      beginRound();
    });
    document.querySelector(".composer-area").append(button);
    if (lockInputs) {
      document.querySelectorAll(".composer-area input, .composer-area button:not([data-next-round])").forEach((element) => {
        element.disabled = true;
      });
    }
  }

  function answerToQuestion(text) {
    const q = normalize(text);
    if (q.includes("家") || q.includes("室內")) return "有可能在家裡看到它喔。";
    if (q.includes("吃") || q.includes("喝")) return "跟食物沒有直接關係。";
    if (q.includes("大") || q.includes("小")) return "它的大小剛好方便日常使用。";
    if (q.includes("顏色")) return "它有很多不同的顏色喔。";
    if (q.includes("每天") || q.includes("常")) return "很多人都會在需要的時候用到它。";
    if (q.includes("折")) return "有些款式是可以折起來的。";
    return "這是個好問題！給你一點方向：日常生活中有時候會用到它。";
  }

  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const field = chatForm.elements.message;
    const value = field.value.trim();
    if (!value || solved) return;
    field.value = "";
    addMessage("you", "你", "你", "avatar-blue", value);
    if (role === "guesser") {
      setTimeout(() => addMessage("opponent", "小島", "小", "avatar-orange", answerToQuestion(value)), 500);
    } else {
      setTimeout(() => addMessage("opponent", "小島", "小", "avatar-orange", "謝謝回答！我好像快想到答案了。"), 500);
    }
  });

  setterForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = setterForm.elements.riddle.value.trim();
    if (!value) return;
    current.riddle = value;
    document.querySelector("[data-riddle]").textContent = value;
    document.querySelector("[data-riddle-label]").textContent = "你的謎題";
    document.querySelector("[data-riddle-help]").textContent = "示範玩家正在猜題；在聊天室回答對方的問題。";
    setterForm.classList.add("hidden");
    chatForm.classList.remove("hidden");
      current.answer = setterForm.elements.answer.value.trim();
      addSystem("謎題送出囉！示範玩家開始猜了。");
    addMessage("opponent", "小島", "小", "avatar-orange", `這和「${current.topic}」有關嗎？`);
      showNextRound({ lockInputs: false });
  });

  guessForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (role !== "guesser") {
      flash("示範版下一輪可以在聊天室體驗出題角色。");
      return;
    }
    const field = guessForm.elements.answer;
    submitGuess(field.value);
    field.value = "";
  });

  document.querySelector("[data-hint]").addEventListener("click", (event) => {
    if (hintUsed) return flash("這個提示已經看過囉，再想想看！");
    hintUsed = true;
    event.currentTarget.disabled = true;
    addMessage("opponent", "小島", "小", "avatar-orange", `給你一點提示：${current.hint}`);
  });

  document.querySelectorAll("[data-start]").forEach((button) => button.addEventListener("click", start));
  document.querySelector("[data-cancel]").addEventListener("click", () => {
    clearTimeout(pendingMatch);
    showView("home");
  });
  document.querySelectorAll("[data-home]").forEach((button) => button.addEventListener("click", () => {
    clearTimeout(pendingMatch);
    clearInterval(timerId);
    role = "guesser";
    round = 1;
    topicNumber = 1;
    showView("home");
  }));
  document.querySelectorAll("[data-show-help]").forEach((button) => button.addEventListener("click", () => modal.showModal()));
  document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => modal.close()));
  modal.addEventListener("click", (event) => { if (event.target === modal) modal.close(); });
  document.querySelector("[data-report]").addEventListener("click", () => flash("展示版尚未接上回報服務。正式上線前會加入這項功能。"));
})();
