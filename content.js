// content.js (runs on x.com)
// Detect "Like" action on a tweet and send tweet context to background.

const DEBUG = false;
const log = (...args) => DEBUG && console.log("[x-like-outline]", ...args);

function norm(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function getTweetPermalink(article) {
  const a = article.querySelector('a[href*="/status/"]');
  if (!a) return null;
  const href = a.getAttribute("href");
  if (!href) return null;
  try {
    return new URL(href, location.origin).toString();
  } catch {
    return null;
  }
}

function getTweetText(article) {
  const el = article.querySelector('div[data-testid="tweetText"]');
  const t = norm(el ? el.innerText : "");
  return t;
}

function getXArticleText() {
  // X "Articles" (longform) use a different layout than tweets.
  // Try to extract the main article text from the page.
  const root =
    document.querySelector('[data-testid="article"]') ||
    document.querySelector('article[role="article"]') ||
    document.querySelector('main');
  if (!root) return "";

  // Prefer visible text blocks.
  const text = norm(root.innerText || "");

  // Heuristic: longform article should be longer than a normal tweet.
  if (text.length < 200) return "";
  return text.slice(0, 40000);
}

function isExternalUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("x.com") || u.hostname.endsWith("twitter.com")) return false;
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function getExternalLinks(article) {
  const anchors = Array.from(article.querySelectorAll('a[href^="http"]'));
  const links = [];
  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (!href) continue;
    // Some links are wrapped (t.co). Still count as external.
    if (isExternalUrl(href)) links.push(href);
  }
  // Deduplicate
  return Array.from(new Set(links));
}

function getThreadText(article) {
  // IMPORTANT:
  // On home timeline / lists, the surrounding DOM contains unrelated tweets/ads.
  // Only collect thread texts when we're on a /status/ page (conversation view).
  const onStatusPage = /\/status\//.test(location.pathname);
  if (!onStatusPage) return [];

  // Conversation timeline container (best effort; X can change labels).
  const container =
    document.querySelector('div[aria-label^="Timeline: Conversation"]') ||
    document.querySelector('div[aria-label*="Conversation"]') ||
    article.closest('main') ||
    document;

  const texts = [];
  const tweetEls = Array.from(container.querySelectorAll('article div[data-testid="tweetText"]'));
  for (const el of tweetEls.slice(0, 12)) {
    const t = norm(el.innerText);
    if (!t) continue;
    texts.push(t);
  }

  // de-dupe + drop the first one if it's identical to the main tweetText
  return Array.from(new Set(texts));
}

function buildPayloadFromArticle(article) {
  const tweetUrl = getTweetPermalink(article);
  let tweetText = getTweetText(article);
  const xArticleText = getXArticleText();
  // If it's an X longform article, prefer its content as the primary text.
  if (!tweetText && xArticleText) tweetText = xArticleText;

  const externalLinks = getExternalLinks(article);
  let threadTexts = getThreadText(article);
  // Avoid duplication: if the first thread text equals the tweet text, drop it.
  if (threadTexts.length && tweetText && threadTexts[0] === tweetText) {
    threadTexts = threadTexts.slice(1);
  }

  return {
    tweetUrl,
    tweetText,
    xArticleText,
    threadTexts,
    externalLinks,
    pageUrl: location.href,
    likedAt: new Date().toISOString()
  };
}

function findActionElFromEvent(e) {
  // X's click target can be svg/path inside the button.
  // Use composedPath() to reliably find the element with data-testid.
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  for (const n of path) {
    if (!n || n.nodeType !== 1) continue;
    const testId = n.getAttribute?.("data-testid") || "";
    if (
      testId === "like" ||
      testId === "unlike" ||
      testId === "bookmark" ||
      testId === "removeBookmark"
    ) {
      return n;
    }
  }
  // Fallback: try closest() from target.
  const t = e.target;
  if (t && t.closest) {
    const btn = t.closest(
      '[data-testid="like"], [data-testid="unlike"], [data-testid="bookmark"], [data-testid="removeBookmark"]'
    );
    if (btn) return btn;
  }
  return null;
}

function findTweetArticleFromClick(el) {
  return el?.closest ? el.closest("article") : null;
}

let lastSentKey = null;

async function onClick(e) {
  const actionEl = findActionElFromEvent(e);
  if (!actionEl) return;

  const testId0 = actionEl.getAttribute("data-testid") || "";

  let eventType = null;
  if (testId0 === "like") eventType = "LIKE_EVENT";
  if (testId0 === "bookmark") eventType = "BOOKMARK_EVENT";
  // Only trigger on the positive actions (not unlike / removeBookmark)
  if (!eventType) return;

  const article = findTweetArticleFromClick(actionEl);
  if (!article) return;

  // DOM changes are async; small delay so tweetUrl/text stabilizes.
  await new Promise((r) => setTimeout(r, 250));

  const payload = buildPayloadFromArticle(article);
  if (!payload.tweetUrl) {
    log("No tweetUrl found, skipping");
    return;
  }

  const key = `${eventType}:${payload.tweetUrl}`;
  if (lastSentKey === key) return;
  lastSentKey = key;

  // attach timestamp field depending on event
  if (eventType === "BOOKMARK_EVENT") payload.savedAt = new Date().toISOString();

  log("Sending payload", eventType, payload);
  try {
    chrome.runtime.sendMessage({ type: eventType, payload }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) console.warn("[x-like-outline] sendMessage failed:", err.message);
      else log("Background ack", resp);
    });
  } catch (err) {
    console.warn("[x-like-outline] sendMessage threw:", err);
  }
}

document.addEventListener("click", onClick, true);
