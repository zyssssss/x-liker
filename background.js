// background.js (MV3 service worker, module)
// Receives LIKE_EVENT from content script, fetches article content (if any),
// calls OpenAI to summarize, stores results in chrome.storage.local.

const DEFAULTS = {
  provider: "deepseek", // "deepseek" | "openai"
  model: "deepseek-chat",
  // Keep only the latest item by default (auto-clear previous).
  // You can change this in Options.
  maxItems: 1,
  language: "zh-CN"
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function norm(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

async function getSettings() {
  const { settings } = await chrome.storage.sync.get(["settings"]);
  return { ...DEFAULTS, ...(settings || {}) };
}

async function getApiKey() {
  // Backward compatible: accept either deepseek_api_key or openai_api_key
  const { deepseek_api_key, openai_api_key } = await chrome.storage.sync.get([
    "deepseek_api_key",
    "openai_api_key"
  ]);
  return (deepseek_api_key || openai_api_key || "").trim();
}

async function addHistoryItem(item) {
  const settings = await getSettings();
  const { history } = await chrome.storage.local.get(["history"]);
  const arr = Array.isArray(history) ? history : [];
  // de-dupe by tweetUrl
  const filtered = arr.filter((x) => x?.tweetUrl !== item.tweetUrl);
  filtered.unshift(item);
  filtered.length = Math.min(filtered.length, settings.maxItems);
  await chrome.storage.local.set({ history: filtered });
  await chrome.action.setBadgeText({ text: String(filtered.length) });
}

async function updateHistoryItem(tweetUrl, patch) {
  const { history } = await chrome.storage.local.get(["history"]);
  const arr = Array.isArray(history) ? history : [];
  const next = arr.map((x) => (x?.tweetUrl === tweetUrl ? { ...x, ...patch } : x));
  await chrome.storage.local.set({ history: next });
}

async function appendReplyLog(tweetUrl, line) {
  const { history } = await chrome.storage.local.get(["history"]);
  const arr = Array.isArray(history) ? history : [];
  const item = arr.find((x) => x?.tweetUrl === tweetUrl);
  const prev = String(item?.replyLog || "");
  const ts = new Date().toLocaleTimeString();
  const next = (prev ? prev + "\n" : "") + `[${ts}] ${line}`;
  await updateHistoryItem(tweetUrl, { replyLog: next.slice(-12000) });
}

async function resolveFinalUrl(url) {
  // Follow redirects (t.co etc.)
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      credentials: "omit",
      cache: "no-store"
    });
    return res.url || url;
  } catch {
    return url;
  }
}

function extractMeta(html, finalUrl) {
  const get = (re) => {
    const m = html.match(re);
    return m ? norm(m[1]) : "";
  };
  const title =
    get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
    get(/<title[^>]*>([^<]+)<\/title>/i);
  const desc =
    get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
    get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  return { title, description: desc, finalUrl };
}

function extractPlainText(html) {
  // Super simple text extraction: strip scripts/styles, then tags.
  // Not perfect, but enough for a fast outline.
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/g, " ");
  s = s.replace(/&amp;/g, "&");
  s = s.replace(/&lt;/g, "<");
  s = s.replace(/&gt;/g, "> ");
  s = s.replace(/\s+/g, " ");
  return s.trim();
}

async function fetchArticle(url) {
  const finalUrl = await resolveFinalUrl(url);
  const res = await fetch(finalUrl, {
    method: "GET",
    redirect: "follow",
    credentials: "omit",
    cache: "no-store"
  });
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html")) {
    return { finalUrl, title: "", description: "", text: "", contentType: ct };
  }
  const html = await res.text();
  const meta = extractMeta(html, finalUrl);
  const text = extractPlainText(html);
  // cap length for model input
  const capped = text.slice(0, 12000);
  return { ...meta, text: capped, contentType: ct };
}

async function scrapeArticleViaTab(url) {
  // Some sites block fetch() from extension SW; use a real tab render + DOM extraction.
  // This is best-effort and capped.
  const finalUrl = await resolveFinalUrl(url);

  const tab = await chrome.tabs.create({ url: finalUrl, active: false });
  const tabId = tab.id;
  if (tabId == null) throw new Error("Failed to create tab for scraping");

  const waitComplete = async (timeoutMs = 20000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const t = await chrome.tabs.get(tabId);
      if (t.status === "complete") return;
      await sleep(250);
    }
    throw new Error("Timeout waiting for article tab to load");
  };

  try {
    await waitComplete();

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const title =
          norm(document.querySelector('meta[property="og:title"]')?.content) ||
          norm(document.title);
        const description =
          norm(document.querySelector('meta[property="og:description"]')?.content) ||
          norm(document.querySelector('meta[name="description"]')?.content);

        // naive main text extraction
        const text = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
        return {
          title,
          description,
          text: text.slice(0, 40000)
        };
      }
    });

    return {
      finalUrl,
      title: result?.title || "",
      description: result?.description || "",
      text: result?.text || "",
      contentType: "text/html"
    };
  } finally {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // ignore
    }
  }
}

async function scrapeXLongformViaTab(tweetUrl) {
  // Best-effort: open the X tweet page and extract longform article text if present.
  const finalUrl = await resolveFinalUrl(tweetUrl);
  const tab = await chrome.tabs.create({ url: finalUrl, active: false });
  const tabId = tab.id;
  if (tabId == null) throw new Error("Failed to create tab for X longform scrape");

  const waitComplete = async (timeoutMs = 20000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const t = await chrome.tabs.get(tabId);
      if (t.status === "complete") return;
      await sleep(250);
    }
    throw new Error("Timeout waiting for X tab to load");
  };

  try {
    await waitComplete();

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const root =
          document.querySelector('[data-testid="article"]') ||
          document.querySelector('article[role="article"]') ||
          document.querySelector('main');

        const text = norm(root?.innerText || "");
        const title = norm(document.querySelector('h1')?.innerText) || norm(document.title);
        return { title, text: text.slice(0, 40000) };
      }
    });

    const text = String(result?.text || "").trim();
    if (text.length < 800) return { finalUrl, title: result?.title || "", text: "" };
    return { finalUrl, title: result?.title || "", text };
  } finally {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // ignore
    }
  }
}

async function llmOutline({ provider, model, language, tweetText, threadTexts, article }) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error(
      provider === "openai"
        ? "Missing OpenAI API key. Set it in extension Options."
        : "Missing DeepSeek API key. Set it in extension Options."
    );
  }

  const system =
    language.startsWith("zh")
      ? "你是一个擅长将文章和社交媒体内容总结成结构化大纲的助手。输出要精炼、可读、可复用。"
      : "You summarize articles and social posts into a structured outline. Be concise and reusable.";

  const userParts = [];
  if (article?.finalUrl) userParts.push(`Article URL: ${article.finalUrl}`);
  if (article?.title) userParts.push(`Article title: ${article.title}`);
  if (article?.description) userParts.push(`Article description(meta): ${article.description}`);
  if (article?.text) userParts.push(`Article text(excerpt): ${article.text}`);

  userParts.push(`Tweet text: ${tweetText || ""}`);
  if (Array.isArray(threadTexts) && threadTexts.length) {
    userParts.push(`Thread texts (up to 8):\n- ${threadTexts.join("\n- ")}`);
  }

  const prompt =
    language.startsWith("zh")
      ? `请根据以上内容输出：\n1) 标题（可自拟）\n2) 文章/线程大纲（5-8 条要点，每条一行，以"- "开头）\n3) 一句话 takeaway（可转发）\n\n要求：\n- 不要胡编；没有信息就写"未知/未提及"\n- 如果文章抓不到正文，就以推文/线程为主\n- 输出纯文本`
      : `Output:\n1) Title\n2) Outline (5-8 bullets, each line starts with "- ")\n3) One-sentence takeaway\n\nRules:\n- No hallucination; say unknown if missing\n- If article body is unavailable, summarize tweet/thread\n- Plain text only`;

  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userParts.join("\n\n") + "\n\n" + prompt }
    ],
    temperature: 0.2
  };

  const endpoint =
    provider === "openai"
      ? "https://api.openai.com/v1/chat/completions"
      : "https://api.deepseek.com/v1/chat/completions";

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const label = provider === "openai" ? "OpenAI" : "DeepSeek";
    throw new Error(`${label} error ${res.status}: ${t.slice(0, 300)}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  return norm(content || "");
}

async function llmReplies({ provider, model, language, tweetText, threadTexts, article }) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error(
      provider === "openai"
        ? "Missing OpenAI API key. Set it in extension Options."
        : "Missing DeepSeek API key. Set it in extension Options."
    );
  }

  if (!article?.text || String(article.text).trim().length < 800) {
    throw new Error("Article body is empty/too short; cannot generate meaningful replies.");
  }

  const system =
    language.startsWith("zh")
      ? "你是一个擅长在X(Twitter)写高质量评论回复的助手。你会基于文章内容给出不同角度的短回复，避免编造。"
      : "You write high-quality X (Twitter) replies based on an article. Provide multiple angles; do not hallucinate.";

  const userParts = [];
  if (article?.finalUrl) userParts.push(`Article URL: ${article.finalUrl}`);
  if (article?.title) userParts.push(`Article title: ${article.title}`);
  if (article?.description) userParts.push(`Article description(meta): ${article.description}`);
  userParts.push(`Article text(excerpt): ${article.text}`);

  if (tweetText) userParts.push(`Tweet text: ${tweetText}`);
  if (Array.isArray(threadTexts) && threadTexts.length) userParts.push(`Thread texts:\n- ${threadTexts.join("\n- ")}`);

  const prompt =
    language.startsWith("zh")
      ? [
          "请只输出严格JSON（不要解释）。字段：",
          "- summary: 1句<=40字",
          "- replies: 6个对象数组，每个对象字段：angle(角度名<=8字)、text(可直接发布<=60字)",
          "角度建议覆盖：赞同/补充案例/提出质疑/提问/提炼方法/幽默但不冒犯。",
          "规则：不要提及‘我无法访问’；不要硬广；不要捏造文章没提到的事实。"
        ].join("\n")
      : [
          "Output strict JSON only (no explanation). Fields:",
          "- summary (<=40 chars)",
          "- replies: array of 6 objects: {angle, text} (text <= 60 chars)",
          "Cover multiple angles. No hallucinations, no ads."
        ].join("\n");

  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userParts.join("\n\n") + "\n\n" + prompt }
    ],
    temperature: 0.6,
    max_tokens: 800
  };

  const endpoint =
    provider === "openai"
      ? "https://api.openai.com/v1/chat/completions"
      : "https://api.deepseek.com/v1/chat/completions";

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const label = provider === "openai" ? "OpenAI" : "DeepSeek";
    throw new Error(`${label} error ${res.status}: ${t.slice(0, 300)}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  const raw = String(content || "").trim();
  if (!raw) throw new Error("Empty model output");

  // Extract JSON best-effort
  const s = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  const jsonStr = first >= 0 && last > first ? s.slice(first, last + 1) : s;

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error("Model did not return valid JSON");
  }

  const replies = Array.isArray(parsed?.replies) ? parsed.replies : [];
  const normReplies = replies
    .map((r) => ({ angle: String(r?.angle || "").trim(), text: String(r?.text || "").trim() }))
    .filter((r) => r.text);

  return {
    summary: String(parsed?.summary || "").trim(),
    replies: normReplies
  };
}

function safeFilename(s) {
  return (s || "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function buildDownloadText({ kind, tweetUrl, tweetText, threadTexts, article, outline }) {
  const lines = [];
  if (kind) lines.push(`# kind: ${kind}`);
  if (tweetUrl) lines.push(`Tweet: ${tweetUrl}`);

  lines.push("\n---\n");

  if (tweetText) {
    lines.push("Tweet text:\n" + tweetText);
    lines.push("\n---\n");
  }

  if (Array.isArray(threadTexts) && threadTexts.length) {
    lines.push("Thread texts:\n- " + threadTexts.join("\n- "));
    lines.push("\n---\n");
  }

  if (article?.finalUrl) {
    lines.push(`Article: ${article.finalUrl}`);
    if (article?.title) lines.push(`Title: ${article.title}`);
    if (article?.description) lines.push(`Description: ${article.description}`);
    lines.push("\n---\n");
  }

  if (article?.text) {
    lines.push("Article text (excerpt):\n" + article.text);
    lines.push("\n---\n");
  }

  if (outline) {
    lines.push("Outline:\n" + outline);
  }

  return lines.join("\n").trim();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (
    msg?.type !== "LIKE_EVENT" &&
    msg?.type !== "BOOKMARK_EVENT" &&
    msg?.type !== "FETCH_ARTICLE_FOR" &&
    msg?.type !== "GENERATE_REPLIES_FOR"
  )
    return;

  (async () => {
    const settings = await getSettings();

    // User-triggered: generate replies for an existing item (bookmark preferred)
    if (msg?.type === "GENERATE_REPLIES_FOR") {
      const tweetUrl = msg?.tweetUrl;
      if (!tweetUrl) return;

      const { history } = await chrome.storage.local.get(["history"]);
      const arr = Array.isArray(history) ? history : [];
      const item = arr.find((x) => x?.tweetUrl === tweetUrl);
      if (!item) return;

      await updateHistoryItem(tweetUrl, {
        status: "generating-replies",
        error: "",
        replyIdeas: [],
        replySummary: "",
        replyLog: ""
      });
      await appendReplyLog(tweetUrl, "开始生成回复");

      try {
        const settings = await getSettings();
        await appendReplyLog(tweetUrl, `LLM: ${settings.provider}/${settings.model}`);

        // Ensure article exists; if not, try fetch now from external link.
        let article = item.article;

        // Prefer X longform body if we already have it (no need for external link).
        if ((!article?.text || String(article.text).trim().length < 800) && item.xArticleText && String(item.xArticleText).trim().length >= 800) {
          await appendReplyLog(tweetUrl, "使用X长文正文作为文章内容");
          article = {
            finalUrl: item.tweetUrl,
            title: item.article?.title || item.tweetText?.slice(0, 80) || "X Article",
            description: "",
            text: String(item.xArticleText).slice(0, 12000),
            contentType: "text/plain"
          };
        }

        if (!article?.text) {
          const firstLink = (item.externalLinks || [])[0];
          if (!firstLink) throw new Error("没有可用的文章正文：既无外链，也无X长文正文");
          await appendReplyLog(tweetUrl, "抓取外链文章正文中…");
          try {
            article = await fetchArticle(firstLink);
          } catch {
            article = await scrapeArticleViaTab(firstLink);
          }
        }

        await appendReplyLog(tweetUrl, `文章正文长度: ${String(article?.text || "").trim().length}`);
        await appendReplyLog(tweetUrl, "调用模型生成多角度回复…");

        const out = await llmReplies({
          provider: settings.provider,
          model: settings.model,
          language: settings.language,
          tweetText: item.xArticleText || item.tweetText,
          threadTexts: item.threadTexts,
          article
        });

        await appendReplyLog(tweetUrl, `生成完成，回复条数: ${(out.replies || []).length}`);
        await updateHistoryItem(tweetUrl, {
          status: "done",
          article,
          replySummary: out.summary || "",
          replyIdeas: out.replies || []
        });
      } catch (e) {
        await appendReplyLog(tweetUrl, `失败: ${e?.message || String(e)}`);
        await updateHistoryItem(tweetUrl, {
          status: "done",
          error: e?.message || String(e)
        });
      }
      return;
    }

    // User-triggered: fetch article later for an existing bookmark item
    if (msg?.type === "FETCH_ARTICLE_FOR") {
      const tweetUrl = msg?.tweetUrl;
      if (!tweetUrl) return;

      const { history } = await chrome.storage.local.get(["history"]);
      const arr = Array.isArray(history) ? history : [];
      const item = arr.find((x) => x?.tweetUrl === tweetUrl);
      if (!item) return;

      const firstLink = (item.externalLinks || [])[0];
      if (!firstLink) {
        await updateHistoryItem(tweetUrl, { error: "No external link found", status: "done" });
        return;
      }

      await updateHistoryItem(tweetUrl, { status: "fetching-article", error: "" });
      let article = null;
      try {
        try {
          article = await fetchArticle(firstLink);
        } catch {
          article = await scrapeArticleViaTab(firstLink);
        }

        const rawText = buildDownloadText({
          kind: item.kind,
          tweetUrl: item.tweetUrl,
          tweetText: item.xArticleText || item.tweetText,
          threadTexts: item.threadTexts,
          article,
          outline: item.outline
        });

        const nameBase = safeFilename(article?.title || item.tweetText || "x-bookmark");
        const downloadName = `x-liker/${nameBase || "x-bookmark"}.txt`;

        await updateHistoryItem(tweetUrl, {
          status: "done",
          article,
          rawText,
          downloadName
        });
      } catch (e) {
        await updateHistoryItem(tweetUrl, {
          status: "done",
          error: e?.message || String(e),
          article
        });
      }
      return;
    }

    // Like/Bookmark events
    const payload = msg.payload || {};
    const kind = msg.type === "LIKE_EVENT" ? "like" : "bookmark";

    const baseItem = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      kind,
      tweetUrl: payload.tweetUrl,
      tweetText: payload.tweetText || "",
      xArticleText: payload.xArticleText || "",
      threadTexts: payload.threadTexts || [],
      externalLinks: payload.externalLinks || [],
      likedAt: payload.likedAt,
      savedAt: payload.savedAt,
      status: "queued",
      article: null,
      outline: "",
      rawText: "",
      downloadName: "",
      error: ""
    };

    await addHistoryItem(baseItem);

    try {
      if (kind === "like") {
        // choose first external link if present
        const firstLink = (baseItem.externalLinks || [])[0];
        let article = null;
        await updateHistoryItem(baseItem.tweetUrl, { status: "fetching" });
        if (firstLink) {
          try {
            article = await fetchArticle(firstLink);
          } catch {
            article = await scrapeArticleViaTab(firstLink);
          }
        }

        await updateHistoryItem(baseItem.tweetUrl, { status: "summarizing", article });

        const outline = await llmOutline({
          provider: settings.provider,
          model: settings.model,
          language: settings.language,
          tweetText: baseItem.tweetText,
          threadTexts: baseItem.threadTexts,
          article
        });

        const rawText = buildDownloadText({
          kind,
          tweetUrl: baseItem.tweetUrl,
          tweetText: baseItem.xArticleText || baseItem.tweetText,
          threadTexts: baseItem.threadTexts,
          article,
          outline
        });

        const nameBase = safeFilename(article?.title || baseItem.tweetText || "x-like");
        const downloadName = `x-liker/${nameBase || "x-like"}.txt`;

        await updateHistoryItem(baseItem.tweetUrl, {
          status: "done",
          outline,
          article,
          rawText,
          downloadName
        });
      } else {
        // bookmark: fetch article content now (so user can generate replies later).
        await updateHistoryItem(baseItem.tweetUrl, { status: "fetching-article", error: "" });

        const firstLink = (baseItem.externalLinks || [])[0];
        let article = null;
        if (firstLink) {
          try {
            try {
              article = await fetchArticle(firstLink);
            } catch {
              article = await scrapeArticleViaTab(firstLink);
            }
          } catch {
            article = null;
          }
        } else {
          // No external link: try scraping X longform body from the tweet page itself.
          try {
            const xlong = await scrapeXLongformViaTab(baseItem.tweetUrl);
            if (xlong?.text) {
              article = {
                finalUrl: xlong.finalUrl,
                title: xlong.title || "X Article",
                description: "",
                text: xlong.text.slice(0, 12000),
                contentType: "text/plain"
              };
            }
          } catch {
            // ignore
          }
        }

        const rawText = buildDownloadText({
          kind,
          tweetUrl: baseItem.tweetUrl,
          tweetText: baseItem.xArticleText || baseItem.tweetText,
          threadTexts: baseItem.threadTexts,
          article,
          outline: null
        });

        const nameBase = safeFilename(article?.title || baseItem.tweetText || "x-bookmark");
        const downloadName = `x-liker/${nameBase || "x-bookmark"}.txt`;

        await updateHistoryItem(baseItem.tweetUrl, {
          status: "done",
          article,
          rawText,
          downloadName,
          // replies are generated on-demand
          replySummary: "",
          replyIdeas: []
        });
      }
    } catch (e) {
      await updateHistoryItem(baseItem.tweetUrl, {
        status: "error",
        error: e?.message || String(e)
      });
    }
  })();

  sendResponse({ ok: true });
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await chrome.action.setBadgeBackgroundColor({ color: "#444" });
  await chrome.action.setBadgeText({ text: "" });

  // initialize settings if empty
  const cur = await chrome.storage.sync.get(["settings"]);
  if (!cur.settings) {
    await chrome.storage.sync.set({ settings });
  }

  // Prefer integrated Side Panel experience.
  try {
    if (chrome.sidePanel?.setOptions) {
      // Set defaults (applies when tabId is omitted).
      await chrome.sidePanel.setOptions({ path: "panel.html", enabled: true });
    }
    if (chrome.sidePanel?.setPanelBehavior) {
      // When user clicks extension icon, open the panel (Chrome-managed).
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
  } catch (e) {
    // Older Chrome versions may not support sidePanel.
    console.warn("Side panel setup failed", e);
  }
});

// Keep the UI visible: open Side Panel when the user clicks the extension icon.
// Note: Side Panel is part of Chrome UI (not a floating window). It will stay on the right
// while you navigate in the same tab.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (!chrome.sidePanel?.open) {
      throw new Error("Side Panel API not available in this Chrome version");
    }

    // Ensure panel is enabled and uses our panel page.
    if (chrome.sidePanel?.setOptions) {
      await chrome.sidePanel.setOptions({
        tabId: tab?.id,
        path: "panel.html",
        enabled: true
      });
    }

    if (tab?.id != null) {
      await chrome.sidePanel.open({ tabId: tab.id });
    }
  } catch (e) {
    // If Side Panel isn't supported, we intentionally do NOT open a floating window.
    // User wants it integrated with Chrome.
    console.warn("Failed to open side panel", e);
  }
});
