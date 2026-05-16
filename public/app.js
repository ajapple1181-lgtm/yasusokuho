const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeNumberText(text) {
  return String(text ?? "")
    .replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0))
    .replace(/[−ー－―]/g, "-");
}

function kanjiToNumber(raw) {
  const s = String(raw ?? "").trim();

  if (/^\d+$/.test(normalizeNumberText(s))) {
    return Number(normalizeNumberText(s));
  }

  const map = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10
  };

  if (s === "十") return 10;

  if (s.includes("十")) {
    const [a, b] = s.split("十");
    const tens = a ? map[a] : 1;
    const ones = b ? map[b] : 0;
    return tens * 10 + ones;
  }

  return map[s] || null;
}

function cleanTweetText(text) {
  return String(text ?? "")
    .replace(/https:\/\/t\.co\/\S+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatDateTime(iso) {
  if (!iso) return "--";
  const d = new Date(iso);
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

function formatClock(iso) {
  if (!iso) return "--:--";
  const d = new Date(iso);
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferTeams(match, tweets) {
  let away = match.awayTeam || "";
  let home = match.homeTeam || "";

  if (away && home) {
    return { away, home };
  }

  const allText = tweets.map((t) => t.text).join("\n");

  const m = allText.match(
    /([一-龥ぁ-んァ-ンA-Za-z0-9０-９]{2,14})\s*(?:vs|VS|ｖｓ|ＶＳ|対|-|－|―)\s*([一-龥ぁ-んァ-ンA-Za-z0-9０-９]{2,14})/
  );

  if (m) {
    away ||= m[1];
    home ||= m[2];
  }

  return {
    away: away || "先攻",
    home: home || "後攻"
  };
}

function extractInning(text) {
  const normalized = normalizeNumberText(text);

  const m = normalized.match(/([0-9]+|[一二三四五六七八九十]+)\s*回?\s*(表|裏)/);

  if (!m) {
    if (/試合終了|ゲームセット/.test(text)) {
      return "試合終了";
    }
    if (/試合開始|プレイボール/.test(text)) {
      return "試合開始";
    }
    return null;
  }

  const inning = kanjiToNumber(m[1]);
  if (!inning) return null;

  return `${inning}回${m[2]}`;
}

function extractScore(text, teams) {
  const normalized = normalizeNumberText(text);
  const away = escapeRegExp(teams.away);
  const home = escapeRegExp(teams.home);

  let m = normalized.match(new RegExp(`${away}\\s*(\\d{1,2})\\s*-\\s*(\\d{1,2})\\s*${home}`));
  if (m) {
    return {
      away: Number(m[1]),
      home: Number(m[2])
    };
  }

  m = normalized.match(new RegExp(`${home}\\s*(\\d{1,2})\\s*-\\s*(\\d{1,2})\\s*${away}`));
  if (m) {
    return {
      away: Number(m[2]),
      home: Number(m[1])
    };
  }

  m = normalized.match(/(?:現在|スコア|得点|計)?\s*(\d{1,2})\s*-\s*(\d{1,2})/);
  if (m && /得点|スコア|現在|リード|同点|先制|勝ち越し|逆転|試合終了|ゲームセット/.test(text)) {
    return {
      away: Number(m[1]),
      home: Number(m[2])
    };
  }

  return null;
}

function classifyEvent(text) {
  const rules = [
    ["final", /試合終了|ゲームセット|終了/, "試合終了"],
    ["score", /得点|先制|勝ち越し|同点|逆転|ホームラン|本塁打|HR|ランニングホームラン/, "得点"],
    ["hit", /ヒット|安打|二塁打|ツーベース|三塁打|スリーベース|内野安打/, "安打"],
    ["change", /投手交代|守備交代|代打|代走|選手交代|継投/, "交代"],
    ["change", /チェンジ|攻守交代/, "チェンジ"],
    ["out", /三振|見逃し|空振り|凡退|フライ|ゴロ|併殺|ダブルプレー|アウト/, "アウト"],
    ["runner", /盗塁|犠打|送りバント|四球|死球|出塁|進塁|満塁|一塁|二塁|三塁/, "走者"],
    ["error", /失策|エラー|悪送球|暴投|捕逸/, "ミス"]
  ];

  for (const [type, regex, label] of rules) {
    if (regex.test(text)) {
      return { type, label };
    }
  }

  return { type: "normal", label: "速報" };
}

function buildLiveData(data) {
  const tweets = data.tweets || [];
  const match = data.match || {};
  const teams = inferTeams(match, tweets);

  const state = {
    awayScore: null,
    homeScore: null,
    status: "試合前"
  };

  const events = tweets.map((tweet) => {
    const text = cleanTweetText(tweet.text);
    const inning = extractInning(text);
    const score = extractScore(text, teams);
    const tag = classifyEvent(text);

    if (inning) {
      state.status = inning;
    }

    if (score) {
      state.awayScore = score.away;
      state.homeScore = score.home;
    }

    return {
      ...tweet,
      cleanText: text,
      inning: inning || state.status,
      tag,
      scoreSnapshot: {
        away: state.awayScore,
        home: state.homeScore
      }
    };
  });

  return {
    match,
    teams,
    events,
    latest: {
      awayScore: state.awayScore,
      homeScore: state.homeScore,
      status: state.status
    }
  };
}

function renderMiniLineScore(match, latest) {
  const innings = Number(match.innings || 7);
  const cells = [];

  for (let i = 1; i <= innings; i++) {
    cells.push(`<span>${i}</span>`);
  }

  cells.push(`<span>計</span>`);

  return cells.join("");
}

function renderEvent(event) {
  const depthClass = event.depth >= 2 ? "depth2" : event.depth === 1 ? "depth1" : "";
  const text = event.cleanText || "本文なし";
  const tagType = event.tag.type;

  return `
    <article class="event ${depthClass}">
      <div class="eventTime">
        <div class="inning">${escapeHtml(event.inning || "速報")}</div>
        <div class="clock">${escapeHtml(formatClock(event.created_at))}</div>
      </div>

      <div class="eventBody">
        <div class="eventTop">
          <span class="tag ${escapeHtml(tagType)}">${escapeHtml(event.tag.label)}</span>
          <span class="replyOrder">#${escapeHtml(event.reply_order)}</span>
        </div>

        <div class="eventText">${escapeHtml(text)}</div>

        <a class="eventLink" href="${escapeHtml(event.url)}" target="_blank" rel="noreferrer">
          Xで元投稿を見る
        </a>
      </div>
    </article>
  `;
}

async function main() {
  const res = await fetch(`./thread.json?ts=${Date.now()}`);

  if (!res.ok) {
    throw new Error("thread.json を読み込めませんでした。");
  }

  const data = await res.json();
  const live = buildLiveData(data);

  const title = live.match.title || "高校軟式野球 速報";
  const subtitle = [
    live.match.subtitle,
    live.match.date,
    live.match.venue
  ].filter(Boolean).join(" / ");

  $("pageTitle").textContent = title;
  $("pageSub").textContent = subtitle || "X投稿から自動生成";
  $("awayName").textContent = live.teams.away;
  $("homeName").textContent = live.teams.home;
  $("awayScore").textContent = live.latest.awayScore ?? "-";
  $("homeScore").textContent = live.latest.homeScore ?? "-";
  $("gameStatus").textContent = live.latest.status || "試合前";
  $("updatedAt").textContent = data.generated_at
    ? `更新 ${formatDateTime(data.generated_at)}`
    : "未更新";
  $("miniLineScore").innerHTML = renderMiniLineScore(live.match, live.latest);

  const feed = $("feed");
  const empty = $("empty");

  if (!live.events.length) {
    empty.hidden = false;
    feed.innerHTML = "";
    return;
  }

  empty.hidden = true;
  feed.innerHTML = live.events.map(renderEvent).join("");
}

main().catch((err) => {
  console.error(err);

  $("pageTitle").textContent = "読み込みエラー";
  $("pageSub").textContent = err.message;
  $("empty").hidden = false;
  $("empty").textContent = "データを読み込めませんでした。GitHub Actionsのログを確認してください。";
});
