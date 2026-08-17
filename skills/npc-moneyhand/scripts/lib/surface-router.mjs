const DESKTOP_ACCESSIBILITY = new Set([
  "browser-chrome",
  "captcha",
  "desktop-app",
  "extension-ui",
  "native-dialog",
  "password-prompt",
  "permission-prompt",
  "print-dialog",
  "save-dialog",
  "security-confirmation",
  "system-auth",
]);

const HUMAN_TAKEOVER = new Set([
  "captcha",
  "password-prompt",
  "security-confirmation",
  "system-auth",
]);

const PAGE_VISUAL = new Set(["canvas", "map", "webgl", "page-visual"]);
const HIGH_IMPACT = new Set(["delete", "external-write", "payment", "publish", "send", "upload"]);

export function routeSurface(input = {}) {
  const surface = typeof input.surface === "string" ? input.surface : "web-page";
  const reason = typeof input.reason === "string" ? input.reason.slice(0, 1_000) : "";
  const risk = typeof input.risk === "string" ? input.risk : "read-only";
  const fallbackAllowed = input.fallbackAllowed !== false;
  const userConfirmed = input.userConfirmed === true;

  if (HIGH_IMPACT.has(risk) && !userConfirmed) {
    return {
      backend: "human",
      mode: "confirmation-required",
      surface,
      risk,
      reason,
      escalation: [],
    };
  }

  if (DESKTOP_ACCESSIBILITY.has(surface)) {
    return {
      backend: "human",
      mode: HUMAN_TAKEOVER.has(surface) ? "human-takeover" : "browser-boundary",
      surface,
      risk,
      reason,
      escalation: [],
    };
  }

  if (PAGE_VISUAL.has(surface) || input.structuredAvailable === false) {
    return {
      backend: "moneyhand",
      mode: "page-visual-cdp-input",
      surface,
      risk,
      reason,
      escalation: fallbackAllowed ? ["human"] : [],
    };
  }

  return {
    backend: "moneyhand",
    mode: "semantic-dom-cdp",
    surface,
    risk,
    reason,
    escalation: fallbackAllowed
      ? ["moneyhand-page-visual", "human"]
      : [],
  };
}
