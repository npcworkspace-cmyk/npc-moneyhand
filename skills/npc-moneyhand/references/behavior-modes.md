# Raw and human behavior

MoneyHand has two task behavior modes. Select the mode once in `beginTaskContext()` and always reset
it through `completeTaskContext()`.

## Raw

Raw is the default. Use it for structured reads, network/DOM observation, deterministic navigation,
semantic resolution, and fast browser actions when the user did not request human pacing.

## Human

Use human only when the user or specialized Skill explicitly asks for human-style interaction, or a
page requires real pointer, keyboard, touch, or wheel input. Human behavior adds bounded pauses,
pointer trajectories, per-character typing cadence, and eased multi-step wheel movement.

```js
const task = await moneyhand.beginTaskContext({
  id: "browse",
  behavior: "human",
  behaviorOptions: {
    ttlMs: 30 * 60_000,
  },
  signal,
});
```

Human behavior affects only actions sent through MoneyHand input:

- `scrollTaskTab()`;
- semantic click, hover, type, key, drag, check, and related guarded input actions;
- an advanced `input.perform` request when no high-level action covers the task.

It does not affect page JavaScript, `Runtime.evaluate`, DOM mutation, direct network requests, or
arbitrary CDP commands. Setting human behavior and then calling `window.scrollBy()` is not
human-style scrolling.

Human behavior is pacing, not authorization or evasion. It does not bypass rate control, CAPTCHA,
challenge pages, account controls, or an unknown-outcome stop. A specialized Skill may tune the
documented behavior options, but must keep the mode task-scoped and reset it in `finally`.

