const connectButton = document.querySelector("#connect");
const statusText = document.querySelector("#status");
let renderRevision = 0;
let connecting = false;

function render(status) {
  const state = status?.state || "ERROR";
  const color = state === "READY" ? "green"
    : ["CONNECTING", "HANDSHAKE"].includes(state) ? "yellow"
      : "red";
  statusText.className = color;
  statusText.textContent = state === "READY" ? "已连接"
    : state === "HANDSHAKE" ? "已发现 · 握手中"
      : state === "CONNECTING" ? "连接中"
        : status?.lastError || "等待 Agent";
  statusText.title = status?.lastError || "";
  connectButton.disabled = connecting;
}

async function requestStatus(type) {
  const failed = (lastError) => ({ state: "ERROR", lastError });
  return await chrome.runtime.sendMessage({ type }).then(
    (status) => status || failed("扩展后台未返回状态，请重新加载 npc-moneyhand"),
    (error) => failed(error instanceof Error ? error.message : String(error)),
  );
}

async function refresh() {
  if (connecting) return;
  const revision = ++renderRevision;
  const status = await requestStatus("popup.status");
  if (revision === renderRevision && !connecting) render(status);
}

connectButton.addEventListener("click", async () => {
  if (connecting) return;
  const revision = ++renderRevision;
  connecting = true;
  connectButton.disabled = true;
  const status = await requestStatus("popup.connect");
  if (revision !== renderRevision) return;
  connecting = false;
  render(status);
});

void refresh();
setInterval(() => void refresh(), 1_000);
