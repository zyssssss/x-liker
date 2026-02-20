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
  return norm(el ? el.innerText : "");
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
  // Best-effort: gather nearby tweet texts in the current conversation view.
  // We keep it conservative to avoid grabbing the whole timeline.
  const container = article.closest('div[aria-label][role="region"], main') || document;
  const texts = [];
  const tweetEls = Array.from(container.querySelectorAll('article div[data-testid="tweetText"]'));
  for (const el of tweetEls.slice(0, 8)) {
    const t = norm(el.innerText);
    if (t) texts.push(t);
  }
  return texts;
}

function buildPayloadFromArticle(article) {
  const tweetUrl = getTweetPermalink(article);
  const tweetText = getTweetText(article);
  const externalLinks = getExternalLinks(article);
  const threadTexts = getThreadText(article);

  return {
    tweetUrl,
    tweetText,
    threadTexts,
    externalLinks,
    pageUrl: location.href,
    likedAt: new Date().toISOString()
  };
}

function isLikeButton(el) {
  const btn = el.closest('div[role="button"], button');
  if (!btn) return false;
  const testId = btn.getAttribute("data-testid") || "";
  // like/unlike toggles; treat click on like button as an intent.
  return testId === "like" || testId === "unlike";
}

function findTweetArticleFromClick(el) {
  return el.closest('article');
}

let lastSentKey = null;

async function onClick(e) {
  const target = e.target;
  if (!target) return;
  if (!isLikeButton(target)) return;

  // Capture intent *before* X swaps the DOM.
  const btn0 = target.closest('div[role="button"], button');
  const testId0 = btn0 ? (btn0.getAttribute("data-testid") || "") : "";
  // Only trigger when user clicks the "like" action (not when unliking).
  if (testId0 !== "like") return;

  const article = findTweetArticleFromClick(target);
  if (!article) return;

  // DOM changes are async; small delay so tweetUrl/text stabilizes.
  await new Promise((r) => setTimeout(r, 250));

  const payload = buildPayloadFromArticle(article);
  if (!payload.tweetUrl) {
    log("No tweetUrl found, skipping");
    return;
  }

  const key = payload.tweetUrl;
  if (lastSentKey === key) return;
  lastSentKey = key;

  log("Sending payload", payload);
  try {
    chrome.runtime.sendMessage({ type: "LIKE_EVENT", payload }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) console.warn("[x-like-outline] sendMessage failed:", err.message);
      else log("Background ack", resp);
    });
  } catch (err) {
    console.warn("[x-like-outline] sendMessage threw:", err);
  }
}

document.addEventListener("click", onClick, true);
