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
    list.appendChild(el("div", { class: "hint", text: "暂无记录。去 x.com 点赞一条带文章链接的推文试试。" }));
    return;
  }

  for (const item of arr) {
    const title = item.article?.title || item.tweetText?.slice(0, 60) || item.tweetUrl;
    const status = item.status || "";

    const header = el("div", { class: "row between" }, [
      el("a", { class: "link", href: item.tweetUrl, target: "_blank", text: title }),
      el("span", { class: "pill", text: status })
    ]);

    const meta = el("div", { class: "hint", text: `${fmtTime(item.likedAt)}${item.article?.finalUrl ? " · " + item.article.finalUrl : ""}` });

    const body = el("pre", { class: "pre" });
    body.textContent = item.outline || (item.error ? `Error: ${item.error}` : "(no outline yet)");

    const actions = el("div", { class: "row" }, [
      el("button", { class: "btn small", text: "Copy" }),
      el("button", { class: "btn small", text: "Open article" })
    ]);

    actions.children[0].addEventListener("click", async () => {
      const text = item.outline || "";
      await navigator.clipboard.writeText(text);
      actions.children[0].textContent = "Copied";
      setTimeout(() => (actions.children[0].textContent = "Copy"), 800);
    });

    actions.children[1].addEventListener("click", async () => {
      const url = item.article?.finalUrl || (item.externalLinks && item.externalLinks[0]);
      if (!url) return;
      chrome.tabs.create({ url });
    });

    const card = el("div", { class: "card" }, [header, meta, body, actions]);
    list.appendChild(card);
  }
}

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("clear").addEventListener("click", async () => {
  if (!confirm("Clear all history?")) return;
  await chrome.storage.local.set({ history: [] });
  await chrome.action.setBadgeText({ text: "" });
  render();
});

// refresh periodically while popup is open
render();
setInterval(render, 1500);
