export const PRODUCT = "npc-moneyhand";
export const PROTOCOL = "npc-moneyhand/2";
export const PROTOCOL_VERSION = 2;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_UNKNOWN_OUTCOME_IDS = 512;
export const MAX_FOCUS_FUTURE_MS = 60_000;

const PROFILE_PATTERN = /^[\p{L}\p{N}_-]{1,64}$/u;

export function profileIsValid(profile) {
  return typeof profile === "string" && PROFILE_PATTERN.test(profile);
}

export function pairingTokenIsValid(token) {
  return token === ""
    || (typeof token === "string" && token.length >= 16 && token.length <= 512);
}
