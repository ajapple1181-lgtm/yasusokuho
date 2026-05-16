import fs from "node:fs/promises";

const API_BASE = "https://api.x.com/2";

const BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const THREAD_ID = process.env.THREAD_ID;
const AUTHOR_USERNAME = process.env.AUTHOR_USERNAME || "yasu19510830";
const INCLUDE_OTHERS = process.env.INCLUDE_OTHERS === "true";
const MAX_PAGES = Number(process.env.MAX_PAGES || 6);

if (!BEARER_TOKEN) {
  throw new Error("X_BEARER_TOKEN が設定されていません。GitHub Secrets に追加してください。");
}

if (!THREAD_ID) {
  throw new Error("THREAD_ID が設定されていません。元投稿URL末尾の数字IDを GitHub Variables に追加してください。");
}

const TWEET_FIELDS = [
  "created_at",
  "conversation_id",
  "referenced_tweets",
  "author_id",
  "in_reply_to_user_id",
  "note_tweet"
].join(",");

const USER_FIELDS = [
  "name",
  "username",
  "profile_image_url"
].join(",");

async function readMatchConfig() {
  try {
    const raw = await fs.readFile("config/match.json", "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function fetchX(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${BEARER_TOKEN}`
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X API error ${res.status}: ${body}`);
  }

  return res.json();
}

function addUsersToMap(usersMap, includes) {
  for (const user of includes?.users || []) {
    usersMap.set(user.id, user);
  }
}

function tweetText(tweet) {
  return tweet.note_tweet?.text || tweet.text || "";
}

function replyParentId(tweet) {
  const ref = tweet.referenced_tweets?.find((r) => r.type === "replied_to");
  return ref?.id || null;
}

function sortAsReplyTree(tweets, rootId) {
  const byId = new Map();
  for (const tweet of tweets) {
    byId.set(tweet.id, tweet);
  }

  const children = new Map();
  const roots = [];

  for (const tweet of tweets) {
    const parent = replyParentId(tweet);

    if (tweet.id === rootId || !parent || !byId.has(parent)) {
      roots.push(tweet);
      continue;
    }

    if (!children.has(parent)) {
      children.set(parent, []);
    }
    children.get(parent).push(tweet);
  }

  const byTime = (a, b) => {
    const da = new Date(a.created_at || 0).getTime();
    const db = new Date(b.created_at || 0).getTime();
    if (da !== db) return da - db;
    return String(a.id).localeCompare(String(b.id));
  };

  roots.sort((a, b) => {
    if (a.id === rootId) return -1;
    if (b.id === rootId) return 1;
    return byTime(a, b);
  });

  for (const list of children.values()) {
    list.sort(byTime);
  }

  const ordered = [];

  function walk(tweet, depth) {
    ordered.push({ tweet, depth });
    const list = children.get(tweet.id) || [];
    for (const child of list) {
      walk(child, depth + 1);
    }
  }

  for (const root of roots) {
    walk(root, root.id === rootId ? 0 : 1);
  }

  return ordered;
}

async function fetchRootTweet(usersMap) {
  try {
    const json = await fetchX("/tweets", {
      ids: THREAD_ID,
      "tweet.fields": TWEET_FIELDS,
      "user.fields": USER_FIELDS,
      expansions: "author_id"
    });

    addUsersToMap(usersMap, json.includes);

    return json.data?.[0] || null;
  } catch (err) {
    console.warn("Root tweet could not be fetched:", err.message);
    return null;
  }
}

async function fetchConversationTweets(usersMap) {
  const tweets = [];

  const query = [
    `conversation_id:${THREAD_ID}`,
    INCLUDE_OTHERS ? "" : `from:${AUTHOR_USERNAME}`,
    "-is:retweet"
  ].filter(Boolean).join(" ");

  let nextToken = null;
  let page = 0;

  do {
    page += 1;

    const json = await fetchX("/tweets/search/recent", {
      query,
      max_results: 100,
      "tweet.fields": TWEET_FIELDS,
      "user.fields": USER_FIELDS,
      expansions: "author_id",
      pagination_token: nextToken
    });

    addUsersToMap(usersMap, json.includes);

    if (Array.isArray(json.data)) {
      tweets.push(...json.data);
    }

    nextToken = json.meta?.next_token || null;
  } while (nextToken && page < MAX_PAGES);

  return { tweets, query };
}

async function main() {
  const match = await readMatchConfig();

  const usersMap = new Map();

  const root = await fetchRootTweet(usersMap);
  const { tweets: replies, query } = await fetchConversationTweets(usersMap);

  const merged = new Map();

  if (root) {
    merged.set(root.id, root);
  }

  for (const tweet of replies) {
    merged.set(tweet.id, tweet);
  }

  const allTweets = [...merged.values()];
  const ordered = sortAsReplyTree(allTweets, THREAD_ID);

  const data = {
    generated_at: new Date().toISOString(),
    source: {
      thread_id: THREAD_ID,
      author_username: AUTHOR_USERNAME,
      include_others: INCLUDE_OTHERS,
      query
    },
    match,
    tweets: ordered.map(({ tweet, depth }, index) => {
      const user = usersMap.get(tweet.author_id) || {};

      return {
        id: tweet.id,
        text: tweetText(tweet),
        created_at: tweet.created_at,
        conversation_id: tweet.conversation_id,
        parent_id: replyParentId(tweet),
        depth,
        reply_order: index + 1,
        author: {
          id: tweet.author_id,
          name: user.name || "",
          username: user.username || AUTHOR_USERNAME,
          profile_image_url: user.profile_image_url || ""
        },
        url: `https://x.com/${user.username || AUTHOR_USERNAME}/status/${tweet.id}`
      };
    })
  };

  await fs.mkdir("public", { recursive: true });
  await fs.writeFile("public/thread.json", JSON.stringify(data, null, 2), "utf8");

  console.log(`Saved public/thread.json: ${data.tweets.length} posts`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
