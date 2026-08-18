import { MoneyHandBridge } from "./bridge.js";
const bridge = new MoneyHandBridge({
  chromeApi: chrome,
  WebSocketImpl: WebSocket,
});
function startBridge() {
  void bridge.start().catch((error) => {
    console.error("npc-moneyhand failed to start", error);
  });
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const operation = {
    "popup.status": () => bridge.status(),
    "popup.connect": () => bridge.connectDefault(),
    "popup.stop": () => bridge.stop(),
  }[message?.type];
  if (!operation) return false;
  void Promise.resolve().then(operation).then(sendResponse, (error) => sendResponse({ enabled: false, state: "ERROR", lastError: error instanceof Error ? error.message : String(error) }));
  return true;
});
chrome.runtime.onStartup.addListener(startBridge);
chrome.runtime.onInstalled.addListener(startBridge);
startBridge();
