(() => {
  "use strict";

  const questionBank = {
    旅行: [
      { prompt: "旅行時，你更喜歡哪一種安排？", choices: ["先規劃好行程", "留點空白隨興走"], demoAnswer: 1 },
      { prompt: "到了陌生城市，你最想先做什麼？", choices: ["找在地小吃", "四處散步看看"], demoAnswer: 0 },
      { prompt: "你比較想把旅行記憶留在哪裡？", choices: ["拍很多照片", "好好感受當下"], demoAnswer: 1 },
      { prompt: "旅途中多出半天空檔，你會？", choices: ["探索沒去過的地方", "找間咖啡店休息"], demoAnswer: 0 },
      { prompt: "你偏好的旅行夥伴是？", choices: ["一起安排、互相提醒", "走到哪裡算哪裡"], demoAnswer: 1 }
    ],
    音樂: [
      { prompt: "聽一首新歌時，你通常先注意？", choices: ["歌詞寫了什麼", "旋律聽起來如何"], demoAnswer: 1 },
      { prompt: "你最常在什麼時候聽音樂？", choices: ["通勤或移動時", "專心休息的時候"], demoAnswer: 0 },
      { prompt: "遇到喜歡的歌，你比較會？", choices: ["立刻分享給朋友", "先收藏起來自己聽"], demoAnswer: 1 },
      { prompt: "如果去聽現場演出，你會？", choices: ["跟著唱、享受熱鬧", "安靜感受每一首歌"], demoAnswer: 0 },
      { prompt: "你的歌單通常比較像？", choices: ["熟悉的歌反覆播放", "常常加入新發現"], demoAnswer: 1 }
    ],
    日常: [
      { prompt: "放假早上，你比較想？", choices: ["早點起床開始一天", "睡到自然醒再說"], demoAnswer: 1 },
      { prompt: "做事時，你偏好哪一種節奏？", choices: ["先排好順序再開始", "想到什麼就先做什麼"], demoAnswer: 0 },
      { prompt: "一天結束後，哪種方式最能放鬆？", choices: ["自己安靜待一會兒", "找人聊聊今天的事"], demoAnswer: 0 },
      { prompt: "你比較常用哪種方式記住事情？", choices: ["寫在行事曆或清單上", "相信自己會記得"], demoAnswer: 1 },
      { prompt: "突然有一小時空檔，你會？", choices: ["完成一件待辦事項", "讓自己放空一下"], demoAnswer: 1 }
    ],
    飲食: [
      { prompt: "點餐時，你通常會選？", choices: ["最熟悉、吃不膩的", "試試沒吃過的新口味"], demoAnswer: 1 },
      { prompt: "你喜歡哪一種早餐？", choices: ["慢慢吃一頓完整早餐", "簡單方便就可以"], demoAnswer: 0 },
      { prompt: "和朋友聚餐時，你比較在意？", choices: ["大家能一起分享食物", "每個人都吃到喜歡的"], demoAnswer: 0 },
      { prompt: "甜點擺在面前，你會？", choices: ["先拍照再開始吃", "趁熱趁新鮮馬上吃"], demoAnswer: 1 },
      { prompt: "喝飲料時，你偏好？", choices: ["固定點最愛的那款", "偶爾換個新口味"], demoAnswer: 1 }
    ]
  };

  const state = {
    topicChoice: "隨機",
    topic: "旅行",
    nickname: "小星",
    matchMode: "demo",
    questionIndex: 0,
    answers: [],
    matchTimer: null,
    shareFile: null,
    shareCardVersion: 0
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const views = $$("[data-view]");
  const modal = $("[data-modal]");
  const toast = $("[data-toast]");

  function showView(name, moveFocus = false) {
    let activeView = null;
    views.forEach((view) => {
      const visible = view.dataset.view === name;
      view.classList.toggle("hidden", !visible);
      view.setAttribute("aria-hidden", String(!visible));
      if (visible) activeView = view;
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
    const focusTarget = activeView && activeView.querySelector("[data-focus-target]");
    if (moveFocus && focusTarget) {
      window.requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
    }
  }

  function chooseTopic() {
    const topics = Object.keys(questionBank);
    if (state.topicChoice === "隨機") {
      state.topic = topics[Math.floor(Math.random() * topics.length)];
    } else {
      state.topic = state.topicChoice;
    }
    return state.topic;
  }

  function startMatching(mode = "demo") {
    window.clearTimeout(state.matchTimer);
    state.shareCardVersion += 1;
    state.shareFile = null;
    state.matchMode = mode;
    state.questionIndex = 0;
    state.answers = [];
    state.nickname = ($("#nickname").value.trim() || "小星").slice(0, 12);
    chooseTopic();
    $("[data-match-topic]").textContent = state.topic;
    const demoMode = mode === "demo";
    $("[data-match-title]").innerHTML = demoMode
      ? "一個好問題，<br><span>從一位新朋友開始。</span>"
      : "等待一位玩家，<br><span>一起探索共同點。</span>";
    $("[data-match-caption]").textContent = demoMode
      ? "正在準備本機範例對局…"
      : "真人配對服務尚未連線，現在不會進入真實佇列。";
    $("[data-match-note]").textContent = demoMode
      ? "這場示範會使用本機範例玩家與答案。"
      : "此為配對等待畫面預覽；加入 30 秒等候上限及跨裝置配對後才會啟用。";
    $("[data-match-progress]").classList.toggle("is-preview", !demoMode);
    $("[data-use-demo]").classList.toggle("hidden", demoMode);
    showView("matching", true);
    if (demoMode) state.matchTimer = window.setTimeout(startDemoGame, 900);
  }

  function startDemoGame() {
    window.clearTimeout(state.matchTimer);
    renderQuestion();
    showView("game", true);
  }

  function createDemoInviteCode() {
    const alphabet = "0123456789ABCDEF";
    let code = "";
    for (let index = 0; index < 12; index += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return code;
  }

  function showRoomPreview(code, joined = false) {
    $("[data-room-title]").textContent = joined ? "房間代碼已輸入" : "邀請房間已建立";
    $("[data-room-status]").textContent = joined
      ? "真人房間驗證尚未連線，這裡不會確認代碼是否有效。"
      : "把代碼分享給朋友，對方加入後就能開始。";
    $("[data-room-code]").textContent = code;
    $("[data-room-note]").textContent = joined
      ? "這是加入流程預覽；目前未連線伺服器，也未加入任何房間。"
      : "這是本機示範代碼，其他裝置目前無法使用。";
    $("[data-copy-room-code]").classList.toggle("hidden", joined);
    showView("invite-room", true);
  }

  function openDemoRoom() {
    state.nickname = ($("#nickname").value.trim() || "小星").slice(0, 12);
    chooseTopic();
    showRoomPreview(createDemoInviteCode());
  }

  function joinDemoRoom() {
    const input = $("#invite-code");
    const code = input.value.trim().toUpperCase();
    if (!/^[0-9A-F]{12}$/.test(code)) {
      announce("請輸入 12 位數字或 A–F 組成的代碼。");
      input.focus();
      return;
    }
    state.nickname = ($("#nickname").value.trim() || "小星").slice(0, 12);
    showRoomPreview(code, true);
  }

  async function copyDemoInviteCode() {
    const code = $("[data-room-code]").textContent;
    try {
      await navigator.clipboard.writeText(code);
      announce("示範代碼已複製。");
    } catch {
      announce("複製功能無法使用，請手動記下代碼。");
    }
  }

  function updateProgress() {
    const questionNumber = state.questionIndex + 1;
    $("[data-question-number]").textContent = String(questionNumber);
    $("[data-game-topic]").textContent = state.topic;
    $("[data-player-name]").textContent = state.nickname;
    $("[data-player-avatar]").textContent = state.nickname.slice(0, 1);
    $("[data-progress]").style.width = String((questionNumber / questionBank[state.topic].length) * 100) + "%";
    const progress = $(".game-progress");
    progress.setAttribute("aria-valuemax", String(questionBank[state.topic].length));
    progress.setAttribute("aria-valuenow", String(questionNumber));
    progress.setAttribute("aria-valuetext", "第 " + questionNumber + " 題，共 " + questionBank[state.topic].length + " 題");

    const answered = state.answers.length;
    const matches = state.answers.filter((answer) => answer.player === answer.opponent).length;
    $("[data-answered-count]").textContent = String(answered);
    $("[data-match-count]").textContent = String(matches);
  }

  function renderQuestion() {
    const question = questionBank[state.topic][state.questionIndex];
    $("[data-question]").textContent = question.prompt;
    $$(".answer-option").forEach((button, index) => {
      button.disabled = false;
      button.classList.remove("is-selected");
      button.setAttribute("aria-pressed", "false");
      $(".option-copy", button).textContent = question.choices[index];
    });
    $("[data-reveal]").classList.add("hidden");
    updateProgress();
  }

  function revealAnswer(selectedIndex) {
    const question = questionBank[state.topic][state.questionIndex];
    const answer = { player: selectedIndex, opponent: question.demoAnswer };
    state.answers[state.questionIndex] = answer;
    const matched = answer.player === answer.opponent;

    $$(".answer-option").forEach((button, index) => {
      button.disabled = true;
      button.classList.toggle("is-selected", index === selectedIndex);
      button.setAttribute("aria-pressed", String(index === selectedIndex));
    });

    $("[data-reveal-heading]").textContent = matched ? "你們找到一個共同點了" : "選擇不一樣，也多認識一點彼此";
    $("[data-reveal-copy]").textContent = matched
      ? "你們都選了「" + question.choices[selectedIndex] + "」。"
      : "每個人的偏好都不同，這也是認識新觀點的開始。";
    $("[data-player-answer]").textContent = question.choices[selectedIndex];
    $("[data-peer-answer]").textContent = question.choices[question.demoAnswer];
    $("[data-reveal]").classList.remove("hidden");
    $("[data-next-label]").textContent = state.questionIndex === questionBank[state.topic].length - 1 ? "看這局結果" : "下一題";
    updateProgress();
    $("[data-next]").focus({ preventScroll: true });
  }

  function renderResults() {
    const questions = questionBank[state.topic];
    const matchedIndexes = state.answers.reduce((indexes, answer, index) => {
      if (answer && answer.player === answer.opponent) indexes.push(index);
      return indexes;
    }, []);
    $("[data-result-score]").textContent = String(matchedIndexes.length);
    $("[data-result-topic]").textContent = state.topic;
    $("[data-result-copy]").textContent = matchedIndexes.length
      ? "這些相同的選擇，是認識彼此的一個小線索。"
      : "答案不一樣也很好，這是認識新觀點的開始。";

    const list = $("[data-result-list]");
    list.replaceChildren();
    matchedIndexes.forEach((index) => {
      const question = questions[index];
      const item = document.createElement("li");
      const prompt = document.createElement("span");
      const choice = document.createElement("b");
      prompt.textContent = question.prompt;
      choice.textContent = question.choices[state.answers[index].player];
      item.append(prompt, choice);
      list.append(item);
    });
    $("[data-empty-result]").classList.toggle("hidden", matchedIndexes.length > 0);
    list.classList.toggle("hidden", matchedIndexes.length === 0);
    showView("results", true);
    prepareShareCard(questions, matchedIndexes);
  }

  function roundedRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  function createShareCard(questions, matchedIndexes) {
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1920;
    const context = canvas.getContext("2d");
    if (!context) return Promise.reject(new Error("無法建立分享圖片"));

    context.fillStyle = "#f7f4ee";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#edf1e8";
    context.beginPath();
    context.arc(940, 330, 250, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#f1e8d8";
    context.beginPath();
    context.arc(80, 1580, 240, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = "#536d4d";
    roundedRect(context, 88, 86, 74, 74, 22);
    context.fill();
    context.fillStyle = "#ffffff";
    context.font = "700 38px 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("同", 125, 124);
    context.textAlign = "left";
    context.fillStyle = "#252820";
    context.font = "700 42px 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
    context.fillText("同頻", 184, 126);
    context.fillStyle = "#777d70";
    context.font = "500 22px 'DM Sans', sans-serif";
    context.textAlign = "right";
    context.fillText("示範對局", 992, 126);

    context.textAlign = "center";
    roundedRect(context, 421, 360, 238, 66, 33);
    context.fillStyle = "#ffffffcc";
    context.fill();
    context.fillStyle = "#536d4d";
    context.font = "600 28px 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
    context.fillText(state.topic + " 主題", 540, 393);

    context.fillStyle = "#777d70";
    context.font = "500 28px 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
    context.fillText("這一局，你們找到", 540, 535);
    context.fillStyle = "#252820";
    context.font = "700 76px 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
    context.fillText(String(matchedIndexes.length) + " 個共同點", 540, 650);
    context.fillStyle = "#536d4d";
    context.font = "700 42px 'DM Sans', sans-serif";
    context.fillText(String(matchedIndexes.length) + " / " + String(questions.length), 540, 750);
    context.fillStyle = "#777d70";
    context.font = "500 22px 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
    context.fillText("相同選擇題數", 540, 795);

    if (matchedIndexes.length) {
      context.textAlign = "left";
      context.fillStyle = "#777d70";
      context.font = "600 22px 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
      context.fillText("你們都這樣選", 94, 900);
      matchedIndexes.forEach((index, position) => {
        const y = 946 + position * 138;
        const question = questions[index];
        roundedRect(context, 88, y, 904, 116, 22);
        context.fillStyle = "#fffefa";
        context.fill();
        context.fillStyle = "#b4834c";
        context.font = "600 19px 'DM Sans', sans-serif";
        context.fillText("0" + String(position + 1), 120, y + 36);
        context.fillStyle = "#777d70";
        context.font = "500 18px 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
        context.fillText(question.prompt, 174, y + 36, 770);
        context.fillStyle = "#3b5439";
        context.font = "700 27px 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
        context.fillText(question.choices[state.answers[index].player], 174, y + 80, 770);
      });
    } else {
      roundedRect(context, 88, 950, 904, 190, 24);
      context.fillStyle = "#fffefa";
      context.fill();
      context.fillStyle = "#3b5439";
      context.font = "600 32px 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
      context.textAlign = "center";
      context.fillText("答案不同，也多認識了一點彼此。", 540, 1045, 820);
      context.fillStyle = "#777d70";
      context.font = "500 22px 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
      context.fillText("每個選擇，都是一個新的話題。", 540, 1100, 820);
    }

    context.textAlign = "center";
    context.fillStyle = "#777d70";
    context.font = "500 24px 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
    context.fillText("一個選擇，發現一點相同", 540, 1798);
    context.fillStyle = "#b4834c";
    context.font = "600 21px 'DM Sans', sans-serif";
    context.fillText("tongpin", 540, 1842);

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("無法輸出分享圖片"));
          return;
        }
        resolve(new File([blob], "tongpin-result.png", { type: "image/png" }));
      }, "image/png");
    });
  }

  function prepareShareCard(questions, matchedIndexes) {
    const version = ++state.shareCardVersion;
    const shareButton = $("[data-share-result]");
    const downloadButton = $("[data-download-result]");
    state.shareFile = null;
    shareButton.disabled = true;
    downloadButton.disabled = true;

    createShareCard(questions, matchedIndexes).then((file) => {
      if (version !== state.shareCardVersion) return;
      state.shareFile = file;
      shareButton.disabled = false;
      downloadButton.disabled = false;
    }).catch(() => {
      if (version !== state.shareCardVersion) return;
      announce("分享圖片暫時無法產生，請重新查看結果。");
    });
  }

  function downloadShareCard() {
    if (!state.shareFile) return;
    const url = URL.createObjectURL(state.shareFile);
    const link = document.createElement("a");
    link.href = url;
    link.download = state.shareFile.name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function shareResult() {
    const file = state.shareFile;
    if (!file) return;
    const files = [file];
    let canShareFiles = false;
    try {
      canShareFiles = Boolean(navigator.share && navigator.canShare && navigator.canShare({ files }));
    } catch {}
    if (!canShareFiles || !navigator.share) {
      downloadShareCard();
      announce("此瀏覽器無法直接分享圖片，已下載 PNG。");
      return;
    }

    const handleShareError = (error) => {
      if (error && error.name === "AbortError") return;
      downloadShareCard();
      announce("分享沒有完成，已下載 PNG 作為備份。");
    };
    try {
      navigator.share({ files, title: "同頻｜二選一共同點" }).catch(handleShareError);
    } catch (error) {
      handleShareError(error);
    }
  }

  function announce(message) {
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(announce.timer);
    announce.timer = window.setTimeout(() => toast.classList.remove("visible"), 2400);
  }

  $$("[data-topic-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      state.topicChoice = button.dataset.topicChoice;
      $$("[data-topic-choice]").forEach((choice) => {
        const selected = choice === button;
        choice.classList.toggle("is-selected", selected);
        choice.setAttribute("aria-pressed", String(selected));
      });
    });
  });

  $("[data-start-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    startMatching("demo");
  });

  $("[data-demo-start]").addEventListener("click", () => startMatching("demo"));
  $("[data-random-match]").addEventListener("click", () => startMatching("random"));
  $("[data-create-room]").addEventListener("click", openDemoRoom);
  $("[data-toggle-join]").addEventListener("click", (event) => {
    const panel = $("[data-join-panel]");
    const expanded = event.currentTarget.getAttribute("aria-expanded") === "true";
    event.currentTarget.setAttribute("aria-expanded", String(!expanded));
    panel.classList.toggle("hidden", expanded);
    if (!expanded) $("#invite-code").focus();
  });
  $("[data-join-room]").addEventListener("click", joinDemoRoom);
  $("#invite-code").addEventListener("input", (event) => {
    event.currentTarget.value = event.currentTarget.value.replace(/[^0-9a-f]/gi, "").toUpperCase().slice(0, 12);
  });
  $("#invite-code").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      joinDemoRoom();
    }
  });
  $("[data-copy-room-code]").addEventListener("click", copyDemoInviteCode);
  $("[data-room-demo]").addEventListener("click", () => startMatching("demo"));
  $("[data-use-demo]").addEventListener("click", startDemoGame);
  $("[data-open-history]").addEventListener("click", () => showView("history", true));

  $$(".answer-option").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.answers[state.questionIndex]) return;
      revealAnswer(Number(button.dataset.option));
    });
  });

  $("[data-next]").addEventListener("click", () => {
    if (state.questionIndex + 1 < questionBank[state.topic].length) {
      state.questionIndex += 1;
      renderQuestion();
      $(".game-question").focus({ preventScroll: true });
    } else {
      renderResults();
    }
  });

  $("[data-cancel]").addEventListener("click", () => {
    window.clearTimeout(state.matchTimer);
    showView("home", true);
    announce("已取消配對");
  });

  $$("[data-home]").forEach((button) => {
    button.addEventListener("click", (event) => {
      if (button.tagName === "A") event.preventDefault();
      window.clearTimeout(state.matchTimer);
      showView("home", true);
    });
  });

  $("[data-play-again]").addEventListener("click", () => startMatching("demo"));
  $("[data-share-result]").addEventListener("click", shareResult);
  $("[data-download-result]").addEventListener("click", downloadShareCard);

  $$("[data-show-help]").forEach((button) => {
    button.addEventListener("click", () => modal.showModal());
  });
  $$("[data-close-modal]").forEach((button) => {
    button.addEventListener("click", () => modal.close());
  });

  showView("home");
})();
