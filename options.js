const $ = (id) => document.getElementById(id);

async function load() {
  const { openai_api_key, settings } = await chrome.storage.sync.get([
    "openai_api_key",
    "settings"
  ]);
  $("apiKey").value = openai_api_key || "";
  $("model").value = settings?.model || "gpt-4o-mini";
  $("language").value = settings?.language || "zh-CN";
  $("maxItems").value = settings?.maxItems || 50;
}

async function save() {
  const apiKey = $("apiKey").value.trim();
  const model = $("model").value.trim() || "gpt-4o-mini";
  const language = $("language").value;
  const maxItems = Math.max(1, Math.min(200, parseInt($("maxItems").value, 10) || 50));

  await chrome.storage.sync.set({
    openai_api_key: apiKey,
    settings: { model, language, maxItems }
  });

  $("status").textContent = "Saved";
  setTimeout(() => ($("status").textContent = ""), 1200);
}

$("save").addEventListener("click", () => save().catch((e) => alert(e.message || String(e))));
load();
