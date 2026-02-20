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
    body.textContent = primaryText || (item.error ? `Error: ${item.error}` : "(no outline yet)");

    const btnCopy = el("button", { class: "btn small", text: "Copy" });
    const btnOpen = el("button", { class: "btn small", text: "Open article" });
    const btnFetch = el("button", { class: "btn small", text: "Fetch external link" });
    const btnDl = el("button", { class: "btn small", text: "Download .txt" });

    const actions = el("div", { class: "row" }, [btnCopy, btnOpen, btnFetch, btnDl]);

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

    // Bookmark flow: user prefers tweet text first; external link is optional.
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

    const card = el("div", { class: "card" }, [header, meta, body, actions]);
    list.appendChild(card);
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
