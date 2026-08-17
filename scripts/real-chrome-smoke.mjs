import { createMoneyHandPeer } from "../skills/npc-moneyhand/scripts/lib/peer.mjs";

const port = Number(process.env.NPC_MONEYHAND_PORT || 19_847);
const pairingToken = process.env.NPC_MONEYHAND_PAIRING_TOKEN || "";

const peer = createMoneyHandPeer({ port, pairingToken });
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  await peer.stop();
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

try {
  const endpoint = await peer.start();
  console.log(JSON.stringify({
    status: "waiting",
    endpoint,
    pairing: pairingToken ? "hmac-sha256" : "none",
  }));

  const session = await peer.waitFor({}, { timeoutMs: 120_000 });
  const status = await session.request({
    id: `smoke:status:${Date.now()}`,
    method: "system.status",
  });
  const targets = await session.request({
    id: `smoke:targets:${Date.now()}`,
    method: "target.list",
  });
  if (!status.ok || !targets.ok) {
    throw new Error(`Read-only smoke failed: ${JSON.stringify({
      systemStatus: status.error,
      targetList: targets.error,
    })}`);
  }
  console.log(JSON.stringify({
    status: "passed",
    identity: session.identity,
    systemStatus: status,
    targetCount: Array.isArray(targets.result?.targets) ? targets.result.targets.length : undefined,
  }));
} finally {
  await stop();
}
