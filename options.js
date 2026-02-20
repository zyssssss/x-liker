const $ = (id) => document.getElementById(id);

async function load() {
  const { deepseek_api_key, openai_api_key, settings } = await chrome.storage.sync.get([
    "deepseek_api_key",
    "openai_api_key",
    "settings"
  ]);

  const provider = settings?.provider || "deepseek";
  $("provider").value = provider;

  // Backward compatible: if provider is openai, prefer openai_api_key; otherwise prefer deepseek_api_key
  const apiKey =
    provider === "openai"
      ? openai_api_key || deepseek_api_key || ""
      : deepseek_api_key || openai_api_key || "";
  $("apiKey").value = apiKey;

  $("model").value = settings?.model || (provider === "openai" ? "gpt-4o-mini" : "deepseek-chat");
  $("language").value = settings?.language || "zh-CN";
  $("maxItems").value = settings?.maxItems ?? 1;
}

async function save() {
  const provider = $("provider").value;
  const apiKey = $("apiKey").value.trim();
  const model =
    $("model").value.trim() || (provider === "openai" ? "gpt-4o-mini" : "deepseek-chat");
  const language = $("language").value;
  const maxItems = Math.max(1, Math.min(200, parseInt($("maxItems").value, 10) || 50));

  // Store key under provider-specific field; keep openai_api_key for backward compat
  const patch = {
    settings: { provider, model, language, maxItems }
  };
  if (provider === "openai") {
    patch.openai_api_key = apiKey;
  } else {
    patch.deepseek_api_key = apiKey;
  }

  await chrome.storage.sync.set(patch);

  $("status").textContent = "Saved";
  setTimeout(() => ($("status").textContent = ""), 1200);
}

$("save").addEventListener("click", () => save().catch((e) => alert(e.message || String(e))));
load();
