# Instagram Automator

> A self-contained, vanilla-JS automation tool for cleaning up your Instagram following list. Sync your followers and following via Instagram's own API, then unfollow everyone who doesn't follow you back — with automatic blacklist and built-in rate-limit protection.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![No dependencies](https://img.shields.io/badge/dependencies-none-brightgreen.svg)]()
[![Single file](https://img.shields.io/badge/size-single%20file-blue.svg)]()

---

## What it does

Instagram Automator is a single JavaScript file that runs directly in your browser on instagram.com. It adds a floating control panel with three buttons and handles the entire cleanup workflow for you:

1. **Sync** — reads your complete Followers and Following lists directly from Instagram's internal API (deterministic, no DOM scraping, no lazy-load issues).
2. **Compare** — knows exactly who follows you and who doesn't.
3. **Act** — unfollows every non-follower with human-like delays, and adds each one to a persistent blacklist so the tool never follows them again.

You stay in control the whole time: nothing runs without your click, everything is logged, and there's a Stop button always visible.

---

## Features

- **Deterministic API scanning** — uses Instagram's `/friendships/` endpoint, not DOM scraping. If you have 189 following, it reports 189 every time. No more counting 179 or 186 randomly.
- **Three-step UI** — Sync → Automate. Nothing to configure if you just want to clean up.
- **Human-like clicks** — every follow/unfollow simulates a full pointer cascade (pointerover → mousedown → mouseup → click) with micro-jitter on coordinates, so the actions look organic.
- **Rate-limit protection** —
  - Configurable batch size and batch delay (Safe Mode: 6 actions then 5 min pause).
  - Separate daily caps for follows and unfollows.
  - Session target (stop after N follows).
  - Silent-rollback detection: if Instagram secretly reverts a follow without showing an error, the tool stops immediately and plays an alert.
- **Auto-blacklist** — every unfollowed account goes to a persistent blacklist. The blacklist survives page reloads and browser restarts.
- **Mutual follower protection** — anyone who follows you back is never touched. Ever.
- **Persistent state** — followers, following, blacklist, daily stats, and follow history are all saved in `localStorage`.
- **Optional verbose logging** — hidden under the Advanced drawer for debugging. Off by default so the log stays clean.

---

## Installation

There are two ways to run it. Pick whichever fits your workflow.

### Method A: Console paste (quickest, no setup)

1. Open [instagram.com](https://www.instagram.com) and log in.
2. Open the browser console:
   - **macOS**: `Cmd + Option + J` (Chrome, Brave, Edge) or `Cmd + Option + C` (Safari with developer tools enabled).
   - **Windows / Linux**: `F12` → Console tab.
3. Open [`script.js`](./script.js) on this repo.
4. Click the **Raw** button (top-right of the file view), then **Ctrl+A** to select all, **Ctrl+C** to copy.
   - Alternatively, hover the code block on the non-Raw view and click the small copy icon in the top-right corner.
5. Paste into the browser console and press Enter.

A dark control panel appears in the top-right corner of the page. Done.

> The script only runs in the current tab. If you reload the page, you need to paste again.

### Method B: Tampermonkey userscript (persistent)

If you plan to use it repeatedly, install it as a userscript so it loads automatically.

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. In Tampermonkey, create a new script.
3. Paste the contents of `script.js` into the editor — but wrap it as a userscript:

   ```javascript
   // ==UserScript==
   // @name         Instagram Automator
   // @namespace    https://github.com/AlphaFinalBoss/instagram-automator
   // @version      2.2
   // @description  Sync followers/following via IG API, unfollow non-followers with auto-blacklist.
   // @match        https://www.instagram.com/*
   // @grant        none
   // @run-at       document-idle
   // ==/UserScript==

   // ... paste the entire script.js contents here ...
```

4. Save. The panel will now appear automatically every time you open Instagram.

---

## Quick Start

The workflow is three clicks. That's it.

### 1. Sync your Followers list

Click **`[Sync Followers]`**. The tool calls Instagram's API and stores your complete Followers list (anyone who follows you). Takes 3–10 seconds depending on size.

### 2. Sync your Following list

Click **`[Sync Following]`**. Same thing, but for the people you follow. Also 3–10 seconds.

The status line at the top now shows: `Following: 189  ·  Followers: 312`.

### 3. Unfollow non-followers

- Click **`[Unfollow Non-Followers]`**.
- A confirmation dialog shows how many accounts will be unfollowed.
- Confirm. The tool opens your Following modal and unfollows each non-follower one by one with human-like delays.
- Each unfollowed account is automatically added to the blacklist.

The log shows progress: `UNFOLLOW #12 (non-follower) -> someusername`.

You can press **`[Stop / Pause]`** at any time to abort mid-run. Anything already done stays done.

---

## Safe Mode vs Fast Mode

The Settings drawer (under `[▾ Advanced]`) has two presets.

| Setting ↕▾ | Safe Mode (default) ↕▾ | Fast Mode ↕▾ |
|---|---|---|
| −Session Target | 20 | unlimited |
| −Daily Cap | 100 | 150 |
| −Batch Size | 6 | 10 |
| −Batch Delay | 300 s (5 min) | 90 s (1.5 min) |
⚙

**Safe Mode** is calibrated from real-world use: 20 follows per session, then stop. This avoids the silent rate-limits Instagram applies around the 20–30 follow mark. Batch delay of 5 minutes matches the platform's typical cooldown window.

**Fast Mode** is aggressive — it will work for some accounts, but carries a higher risk of hitting a soft block. Not recommended for accounts you care about.

You can customize any value in the Settings drawer. Any change auto-switches the preset to "Custom".

---

## How it works

### Why the API and not the page?

Instagram renders its Followers and Following lists with a virtualized React list — only ~10 rows exist in the DOM at any time. Scraping them requires scrolling in precise increments and guessing when React has finished mounting new rows. This is non-deterministic: you get 179, 184, 186, 187, etc. on the same list.

This tool instead uses Instagram's internal friendships endpoint:

```
GET https://www.instagram.com/api/v1/friendships/{user_id}/{followers|following}/?count=200&max_id=...
```

It returns paginated JSON with 200 users per request (server-side pagination via `next_max_id`). No rendering, no timing, no variance. The tool also handles the eventual-consistency quirk where early pages arrive short by running up to 3 union passes; typical convergence is 1–2 passes.

### Auto-blacklist

Every successfully unfollowed account is written to a `sa_blacklist` array in `localStorage`. The follow loop reads this array before every action and skips anyone on it. Net effect: once you unfollow someone, you never accidentally follow them again.

### Mutual follower protection

The Followers list is the source of truth for mutual protection. Before unfollowing anyone, the tool checks `sa_my_followers`. If the target is in that list, they're skipped with `PROTECTED (mutual follow)`.

If your Followers list is empty when you click `[Unfollow Non-Followers]`, the tool refuses to run — otherwise it would unfollow everyone, including mutuals.

### Silent rollback detection

Instagram sometimes accepts a follow click and quietly reverts it 1–2 seconds later without showing any error (this is the "shadow rate-limit"). The tool waits 1.8 s after each follow, re-reads the button state, and if it has reverted to "Follow", it stops the entire run, plays a double alert tone, and shows a red warning banner. This is your signal to stop for the day.

---

## Safety and warnings

**Read this before using.**

- **This automates actions on your personal Instagram account.** Any third-party tool that does this carries a risk of account restrictions. You are doing this at your own risk.
- **Never set the daily cap above 150.** Instagram's actual follow limit for new accounts is often below 200, and behavioral flags don't appear immediately. Safe Mode's 100 is genuinely safe; 150 is a ceiling, not a target.
- **The 24-hour cooldown that older versions had is gone.** The current Unfollow Non-Followers action will unfollow non-followers regardless of how recently you followed them. If you want to give someone 24h to follow you back, don't run the unfollow loop that day.
- **Only run it on your own account.** It uses your session cookies (`ds_user_id`, `csrftoken`) and performs actions as you.
- **Cookies stay local.** Nothing is sent anywhere except to instagram.com via the fetch calls that the tool makes. There is no backend, no telemetry, no analytics.
- **No warranty.** MIT license — see [LICENSE](https://./LICENSE). If Instagram changes their API and the tool stops working, that's on the platform, not on the tool.

---

## Settings reference

Open the Advanced drawer to access:

- **Preset** — Safe / Fast / Custom.
- **Session Target** — stop the follow loop after N follows in one run. 0 means unlimited.
- **Daily Cap** — maximum follows *and* maximum unfollows per day, tracked separately.
- **Batch Size** — how many actions before a long pause.
- **Batch Delay** — length of the pause, in seconds.
- **Show debug logs** — verbose output for troubleshooting. Adds API pagination details, stall detection, and target parsing to the log.
- **Manual blacklist input** — add a username directly without running a sync.
- **Export / Clear Blacklist** — downloads the blacklist as JSON and optionally wipes it.

---

## Troubleshooting

### "Sync failed: NO_CSRF" or "API unavailable"

Instagram's session cookies weren't readable. Usually caused by:

- You're not logged in to Instagram. Log in first.
- A browser extension is stripping cookies. Try in a private window with extensions disabled.
- Brave Shields: `Block third-party cookies` doesn't affect us (the cookies we need are first-party), but aggressive script blockers might. Try `Allow all cookies` for instagram.com and reload.

If the API is truly unreachable, the tool falls back to the older DOM-scraping path automatically. It's slower and less accurate, but functional.

### "Refusing to run: Followers list is empty"

You clicked `[Unfollow Non-Followers]` without a Followers sync. This is a safety guard — without the Followers list, the tool has no way to protect mutuals. Click `[Sync Followers]` first.

### "RATE LIMIT DETECTED (Silent Rollback)"

Instagram is silently reverting your follows. Stop for the day. Come back tomorrow, and consider running a lower session target (10 instead of 20) going forward.

### The panel disappeared after reload

Method A (console paste) doesn't persist across page loads. Re-paste the script, or switch to Method B (Tampermonkey).

### "No modal found"

The tool needs to see Instagram's Followers or Following modal to know what to scan. Open the modal first, then click the button.

---

## Project structure

```
instagram-automator/
├── script.js       # The entire tool (single file, no build step)
├── README.md       # This file
├── LICENSE         # MIT license
└── .gitignore
```

No `package.json`, no dependencies, no build. The file is loaded as-is.

---

## Data storage

Everything is in `localStorage` under keys prefixed with `sa_`:

| Key ↕▾ | What it stores ↕▾ |
|---|---|
| −`sa_blacklist` | Array of usernames you've unfollowed or manually blacklisted. |
| −`sa_follow_history` | Object of `{ username: timestamp }` for accounts you've followed with this tool. |
| `sa_my_followers` | Array of usernames who follow you (from the last sync). |
| `sa_my_following` | Array of usernames you follow (from the last sync). |
| `sa_daily_stats` | `{ date, follows, unfollows }` — reset daily. |
| `sa_settings` | Your preset and custom settings. |
| `sa_last_sync` | Timestamps of the last followers/following sync. |
⚙

To wipe everything: open the browser console and run `localStorage.clear()`. Warning: this also clears any other site data on instagram.com.

---

## Contributing

Issues and pull requests welcome. The code is a single file with no build system, so changes are easy to test — just paste the modified `script.js` into your console and reload Instagram.

Before submitting a PR:

- Run `node --check script.js` to verify syntax.
- Keep the vanilla-JS, no-dependency philosophy.
- Keep all user-facing strings and log messages in English.

---

## License

[MIT](https://./LICENSE). Do whatever you want, no warranty, no attribution required.

---

## Disclaimer

This project is not affiliated with Instagram or Meta. It's a browser-side automation tool that uses publicly-reachable endpoints on the site you're already logged in to. You assume all responsibility for how you use it.

