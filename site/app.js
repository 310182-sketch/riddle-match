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
    questionIndex: 0,
    answers: [],
    matchTimer: null
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

  function startMatching() {
    window.clearTimeout(state.matchTimer);
    state.questionIndex = 0;
    state.answers = [];
    state.nickname = ($("#nickname").value.trim() || "小星").slice(0, 12);
    chooseTopic();
    $("[data-match-topic]").textContent = state.topic;
    showView("matching", true);
    state.matchTimer = window.setTimeout(() => {
      renderQuestion();
      showView("game", true);
    }, 900);
  }

  function updateProgress() {
    const questionNumber = state.questionIndex + 1;
    $("[data-question-number]").textContent = String(questionNumber);
    $("[data-game-topic]").textContent = state.topic;
    $("[data-player-name]").textContent = state.nickname;
    $("[data-player-avatar]").textContent = state.nickname.slice(0, 1);
    $("[data-progress]").style.width = String((questionNumber / questionBank[state.topic].length) * 100) + "%";

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
    startMatching();
  });

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

  $("[data-play-again]").addEventListener("click", startMatching);

  $$("[data-show-help]").forEach((button) => {
    button.addEventListener("click", () => modal.showModal());
  });
  $$("[data-close-modal]").forEach((button) => {
    button.addEventListener("click", () => modal.close());
  });

  showView("home");
})();
