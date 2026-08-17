import { DEFAULT_ADDRESS, DEFAULT_ENDPOINT, DEFAULT_PORT, addressIsAllowed, endpointAddressPort, portIsValid } from "./protocol.js";
const form = document.querySelector("#connection");
const addressInput = document.querySelector("#address");
const portInput = document.querySelector("#port");
const saveButton = document.querySelector("#save");
const statusText = document.querySelector("#status");
let renderRevision = 0;
let configuring = false;
function render(status) {
  const state = status?.state || "ERROR";
  const color = state === "READY" ? "green"
    : ["CONNECTING", "HANDSHAKE"].includes(state) ? "yellow"
      : "red";
  statusText.className = color;
  statusText.textContent = state === "READY" ? "已连接"
    : state === "HANDSHAKE" ? "已发现 · 握手中"
      : state === "CONNECTING" ? "连接中"
        : status?.lastError || (status?.enabled ? "未连接" : "未启用");
  statusText.title = status?.lastError || "";
  saveButton.disabled = configuring;
}
async function requestStatus(message, enabled) {
  const failed = (lastError) => ({ enabled, state: "ERROR", lastError });
  const payload = typeof message === "string" ? { type: message } : message;
  return await chrome.runtime.sendMessage(payload).then((status) => status || failed("扩展后台未返回状态，请重新加载 npc-moneyhand"), (error) => failed(error instanceof Error ? error.message : String(error)));
}
async function refresh() {
  const revision = ++renderRevision;
  const stored = await chrome.storage.local.get({ wsEndpoint: DEFAULT_ENDPOINT, enabled: false });
  if (revision !== renderRevision) return;
  const endpoint = endpointAddressPort(stored.wsEndpoint) || { address: DEFAULT_ADDRESS, port: DEFAULT_PORT };
  addressInput.value = endpoint.address;
  portInput.value = String(endpoint.port);
  const status = await requestStatus("popup.status", stored.enabled);
  if (revision === renderRevision && !configuring) render(status);
}
async function pollStatus() {
  if (configuring) return;
  const revision = ++renderRevision;
  const status = await requestStatus("popup.status", true);
  if (revision === renderRevision && !configuring) render(status);
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (configuring) return;
  const revision = ++renderRevision;
  const address = addressInput.value.trim();
  const port = portInput.value.trim();
  if (!addressIsAllowed(address)) {
    render({ lastError: "地址仅支持 127.0.0.1、localhost 或 ::1" });
    addressInput.focus();
    return;
  }
  if (!portIsValid(port)) {
    render({ lastError: "端口必须是 1–65535" });
    portInput.focus();
    return;
  }
  configuring = true;
  saveButton.disabled = true;
  const status = await requestStatus({ type: "popup.configure", address, port: Number(port) }, true);
  if (revision !== renderRevision) return;
  configuring = false;
  render(status);
});
void refresh();
setInterval(() => void pollStatus(), 1_000);
