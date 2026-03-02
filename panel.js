// panel.js (Chrome Side Panel)
// Same UI/logic as popup.js, but designed to stay open.

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.appendChild(c);
  return e;
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso || "";
  }
}

async function render() {
  const { history } = await chrome.storage.local.get(["history"]);
  const arr = Array.isArray(history) ? history : [];
  const list = document.getElementById("list");
  list.innerHTML = "";

  if (!arr.length) {
    list.appendChild(
      el("div", {
        class: "hint",
        text: "暂无记录。去 x.com 点赞一条带文章链接的推文试试。"
      })
    );
    return;
  }

  for (const item of arr) {
    const title = item.article?.title || item.tweetText?.slice(0, 60) || item.tweetUrl;
    const status = item.status || "";

    const header = el("div", { class: "row between" }, [
      el("a", { class: "link", href: item.tweetUrl, target: "_blank", text: title }),
      el("span", { class: "pill", "data-status": status, text: status })
    ]);

    const meta = el("div", {
      class: "hint",
      text: `${fmtTime(item.likedAt)}${item.article?.finalUrl ? " · " + item.article.finalUrl : ""}`
    });

    const body = el("pre", { class: "pre" });
    const primaryText = item.outline || item.rawText || "";

    const repliesBlock = Array.isArray(item.replyIdeas) && item.replyIdeas.length
      ? [
          item.replySummary ? `Reply summary: ${item.replySummary}` : "",
          ...item.replyIdeas.map((r, i) => {
            const angle = r.angle ? `【${r.angle}】` : "";
            return `${i + 1}. ${angle}${r.text}`;
          })
        ].filter(Boolean).join("\n")
      : "";

    const statusHint = status && status !== "done" ? `[${status}]` : "";
    const errLine = item.error ? `\n\nError: ${item.error}` : "";
    body.textContent = (repliesBlock || primaryText || "(no content yet)") + (statusHint ? `\n\n${statusHint}` : "") + errLine;

    const btnCopy = el("button", { class: "btn small", text: "Copy" });
    const btnOpen = el("button", { class: "btn small", text: "Open article" });
    const btnFetch = el("button", { class: "btn small", text: "Fetch external link" });
    const btnGen = el("button", { class: "btn small", text: "生成回复" });
    const btnDl = el("button", { class: "btn small", text: "Download .txt" });

    const actions = el("div", { class: "row" }, [btnCopy, btnOpen, btnFetch, btnGen, btnDl]);

    btnCopy.addEventListener("click", async () => {
      const text = primaryText || "";
      await navigator.clipboard.writeText(text);
      btnCopy.textContent = "Copied";
      setTimeout(() => (btnCopy.textContent = "Copy"), 800);
    });

    btnOpen.addEventListener("click", async () => {
      const url = item.article?.finalUrl || (item.externalLinks && item.externalLinks[0]);
      if (!url) return;
      chrome.tabs.create({ url });
    });

    // Bookmark flow: external link is optional.
    const hasExternal = Array.isArray(item.externalLinks) && item.externalLinks.length > 0;
    const canFetch = hasExternal && !item.article?.text && item.status === "done";
    btnFetch.disabled = !canFetch;
    btnFetch.style.opacity = canFetch ? "1" : "0.5";
    btnFetch.addEventListener("click", async () => {
      if (!canFetch) return;
      btnFetch.textContent = "Fetching...";
      try {
        chrome.runtime.sendMessage({ type: "FETCH_ARTICLE_FOR", tweetUrl: item.tweetUrl });
      } finally {
        setTimeout(() => (btnFetch.textContent = "Fetch external link"), 1200);
      }
    });

    const hasBody = (item.article && item.article.text) || (item.xArticleText && item.xArticleText.length > 800);
    const canGen = item.status === "done" && !!hasBody && (item.kind === "bookmark" || item.kind === "like");
    btnGen.disabled = !canGen;
    btnGen.style.opacity = canGen ? "1" : "0.5";
    btnGen.title = canGen
      ? ""
      : hasExternal
        ? "未抓到文章正文：先点 Fetch external link 抓取文章内容"
        : (item.xArticleText && item.xArticleText.length < 800)
          ? "当前是X长文但正文太短/未加载完全"
          : "这条收藏没有外链文章正文可用（没有 external link / 也不是X长文）";
    btnGen.addEventListener("click", async () => {
      if (!canGen) return;
      btnGen.textContent = "生成中...";
      btnGen.disabled = true;
      try {
        chrome.runtime.sendMessage({ type: "GENERATE_REPLIES_FOR", tweetUrl: item.tweetUrl }, () => {
          // background runs async; UI will refresh via interval.
        });
      } finally {
        setTimeout(() => {
          btnGen.textContent = "生成回复";
          btnGen.disabled = false;
        }, 1200);
      }
    });

    // Enable download when we have rawText.
    const canDownload = !!item.rawText && item.status === "done";
    btnDl.disabled = !canDownload;
    btnDl.style.opacity = canDownload ? "1" : "0.5";
    btnDl.addEventListener("click", async () => {
      if (!canDownload) return;
      const text = item.rawText || "";
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      try {
        await chrome.downloads.download({
          url,
          filename: item.downloadName || "x-liker/bookmark.txt",
          saveAs: true
        });
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    });

    // If replies exist, render per-reply actions (copy / insert to X composer)
    if (Array.isArray(item.replyIdeas) && item.replyIdeas.length) {
      const repliesWrap = el("div", { class: "list" });

      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTabId = tabs?.[0]?.id;

      for (const r of item.replyIdeas.slice(0, 10)) {
        const row = el("div", { class: "card" });
        const t = `${r.angle ? `【${r.angle}】` : ""}${r.text}`;
        row.appendChild(el("div", { class: "hint", text: r.angle || "reply" }));
        row.appendChild(el("div", { class: "pre", text: t }));

        const b1 = el("button", { class: "btn small", text: "复制" });
        const b2 = el("button", { class: "btn small", text: "填入回复框" });
        const act = el("div", { class: "row" }, [b1, b2]);

        b1.addEventListener("click", async () => {
          await navigator.clipboard.writeText(r.text);
          b1.textContent = "Copied";
          setTimeout(() => (b1.textContent = "复制"), 800);
        });

        b2.disabled = !activeTabId;
        b2.style.opacity = activeTabId ? "1" : "0.5";
        b2.addEventListener("click", async () => {
          if (!activeTabId) return;
          try {
            await chrome.tabs.sendMessage(activeTabId, { type: "INSERT_REPLY", text: r.text });
          } catch {
            // ignore
          }
        });

        row.appendChild(act);
        repliesWrap.appendChild(row);
      }

      const card = el("div", { class: "card" }, [header, meta, body, actions, repliesWrap]);
      list.appendChild(card);
    } else {
      const card = el("div", { class: "card" }, [header, meta, body, actions]);
      list.appendChild(card);
    }
  }
}

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function downloadTextFile({ text, filename, saveAs }) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename: filename || "x-liker/export.txt",
      saveAs: !!saveAs
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

document.getElementById("downloadAll").addEventListener("click", async () => {
  const { history } = await chrome.storage.local.get(["history"]);
  const arr = Array.isArray(history) ? history : [];
  const done = arr.filter((x) => x?.status === "done" && x?.rawText);
  if (!done.length) {
    alert("No downloadable items yet (need status=done). ");
    return;
  }

  const combined = done
    .map((x, i) => `===== ${i + 1}/${done.length} =====\n${x.rawText}`)
    .join("\n\n");

  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  await downloadTextFile({
    text: combined,
    filename: `x-liker/x-liker-export-${ts}.txt`,
    saveAs: true
  });
});

document.getElementById("clear").addEventListener("click", async () => {
  if (!confirm("Clear all history?")) return;
  await chrome.storage.local.set({ history: [] });
  await chrome.action.setBadgeText({ text: "" });
  render();
});

// refresh periodically while panel is open
render();
setInterval(render, 1500);
