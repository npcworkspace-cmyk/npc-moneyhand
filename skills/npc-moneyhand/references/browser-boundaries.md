# Browser boundaries

Use this reference when the target may be outside the web page. `routeSurface()` is pure: it returns
a route but never performs an action. Its only backends are `moneyhand` and `human`.

## Routing order

1. MoneyHand semantic DOM/CDP
2. MoneyHand page visual capture with CDP Input
3. Human takeover

| Surface | Route |
| --- | --- |
| Normal web page | MoneyHand semantic DOM/CDP |
| Canvas, map, WebGL, page visual | MoneyHand page visual + CDP Input |
| Browser chrome, native save/print dialog, permission prompt, desktop app | Human takeover |
| System authentication, password, CAPTCHA, security confirmation | Human takeover |
| High-impact action without current confirmation | Human confirmation required |

Set `fallbackAllowed:false` to suppress optional escalation from a reachable page action. A native or
system surface still returns the terminal `human` boundary because MoneyHand cannot act on it. Never
turn that route into automatic native input.

```js
const route = moneyhand.routeSurface({
  surface: "save-dialog",
  risk: "read-only",
  reason: "The page cannot inspect the native dialog"
});

if (route.backend === "human") {
  // Report the bounded state and wait for the user or calling Agent to hand control back.
}
```

## Safety boundary

- Keep browser-page actions inside Chrome's page targets and extension permissions.
- Treat the browser toolbar, extension UI, native dialogs, and other applications as unreachable.
- Route system auth, passwords, CAPTCHA, and security confirmations to a human.
- Never pass `css-viewport-v1` coordinates to screen or native UI.
- After human takeover, re-observe the exact Profile, boot, tab, URL, and page state before resuming.
- Inspect real state before retrying any action whose dispatch outcome is unknown.
