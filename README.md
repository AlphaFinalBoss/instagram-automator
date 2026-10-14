# Instagram Automator

A small browser script that helps you clean up your Instagram following list. It syncs your followers and following through Instagram's own API, shows you who doesn't follow you back, and unfollows them one by one with human-like delays. Everyone it unfollows gets blacklisted so you never follow them again by accident.

No install. No build. One file. Paste it in your browser, click three buttons.

## What it does

Instagram doesn't have a "who doesn't follow me back" view. This tool does.

You open Instagram, paste the script in the browser console, and get a floating panel in the top-right corner. From there:

1. Click **Sync Followers** to pull your complete follower list.
2. Click **Sync Following** to pull everyone you follow.
3. Click **Unfollow Non-Followers** to remove the people who don't follow you back.

Everything else happens automatically. Every unfollow is spaced out with random delays, mutual followers are never touched, accounts you followed less than 24 hours ago are left alone, and each unfollowed account goes into a blacklist so it can't sneak back into your following later.

## Why this approach

Most Instagram cleanup tools scrape the DOM, which is fragile. Instagram's follower lists are rendered by React with virtualization: only 10-15 rows exist in the HTML at any given moment. You have to scroll in tiny increments, wait for React to mount new rows, and hope you didn't skip any.

I spent weeks fighting this. Same list would return 179 one run, 186 the next, 189 the third. The count was never stable.

Then I switched to Instagram's internal API:

```

GET /api/v1/friendships/{user_id}/{followers|following}/?count=200&max_id=...

```

One request returns 200 users. Pagination is a simple cursor. No scrolling, no timing, no guessing. 189 means 189 every single time, in about 3 seconds.

The tool falls back to the DOM scraping path if the API is unavailable (missing cookies, blocked by extensions), but the API path is what you want.

## Features

**Deterministic scanning.** API-based, so results are consistent. No more "why does it say 186 this time".

**Three steps, no config.** Sync, then unfollow. Sensible defaults are already safe. You don't need to touch the settings unless you want to.

**Follow loop that respects private accounts.** When you follow a private account, Instagram shows "Requested" instead of "Following". That's not a follow yet, it's a pending request. The tool tracks these separately: they don't count toward your daily follow cap, and they get reconciled automatically on your next Following sync. If the person accepts, the request is promoted to a real follow in history. If they don't, it stays pending until you look.

**Human-like clicks.** Each follow and unfollow fires a full pointer cascade (pointerover, mousedown, mouseup, click) with a few pixels of random jitter on the coordinates. It's still a synthetic click, but it doesn't look like a bot hammering a button.

**Rate-limit protection built in.** Configurable batch size, batch delay, daily cap for follows and unfollows tracked separately, and a session target. Safe Mode runs 6 actions then pauses 5 minutes, stops after 20 follows total. That matches Instagram's real cooldown window.

**Silent rollback detection.** Instagram sometimes accepts a follow click and quietly reverts it 2 seconds later without showing you an error. The tool waits, re-reads the button, and if it has flipped back to "Follow", stops the whole run and plays an alert. That's your signal to close the tab and try tomorrow.

**Auto-blacklist.** The follow loop checks the blacklist before every action, so once someone is out, they stay out. Two groups go in automatically:

- Everyone you unfollow because they didn't follow back. They are blacklisted only after the unfollow is confirmed (the button flips back to "Follow").
- Everyone who follows you but you don't follow back. They are blacklisted after each sync, so the follow loop never follows them.

**Mutual follower protection.** Anyone who follows you is skipped with `PROTECTED (follows you)` in the log. The unfollow loop doesn't trust an old sync: it re-fetches your Followers list from the API when it starts and again after every batch pause, and re-checks each account right before clicking. If that refresh fails, it refuses to run.

**New-follow protection.** Nobody is unfollowed within 24 hours of being followed, so they get a fair chance to follow back. This covers follows made by the script and follows you made yourself (on your phone, say): the tool records when each account first shows up in a Following sync. Accounts that appeared after your last Following sync are always skipped, because their age is unknown.

**Everything is local.** State lives in your browser's `localStorage`. Nothing is sent anywhere except to instagram.com through the requests the tool itself makes.

## Install

Pick one.

### Method A: Paste in console

Fastest. Nothing to install, but you have to re-paste every time you reload Instagram.

1. Open instagram.com and log in.
2. Open the browser console. On Mac: Cmd+Option+J in Chrome, Brave or Edge. On Windows and Linux: F12 then Console tab.
3. Open [script.js](script.js) on this repo, click the Raw button, select all (Ctrl+A or Cmd+A), copy.
4. Paste in the console and hit Enter.

A dark panel shows up in the top-right corner of the page.

### Method B: Tampermonkey userscript

Better if you use it regularly. It loads automatically on every Instagram visit.

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Create a new userscript in Tampermonkey.
3. Paste the entire contents of `script.js` wrapped like this:

```javascript
// ==UserScript==
// @name         Instagram Automator
// @namespace    https://github.com/AlphaFinalBoss/instagram-automator
// @version      2.3
// @description  Sync followers/following via IG API, unfollow non-followers with auto-blacklist.
// @match        https://www.instagram.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// paste the whole script.js here
```

4. Save. From now on the panel appears by itself whenever you open Instagram.

## How to use it

Three buttons, in order.

**Sync Followers.** Click it. Takes a few seconds. The status line updates to show your follower count. No modal needs to be open.

**Sync Following.** Click it. Same thing, for the people you follow. The unfollow loop refuses to run until you've done this, because it needs the list to know how long you've followed each account.

**Unfollow Non-Followers.** Open your Following modal on Instagram, then click it. The tool refreshes your Followers list, logs how many accounts are eligible, and works through the list. The log shows why each account is skipped (`PROTECTED (follows you)`, `SKIP (followed 5h ago, cooldown 24h)`). Each unfollow takes 3-6 seconds, with a 5-minute pause after every 6 actions in Safe Mode.

Press **Stop / Pause** any time. A follow or unfollow that was already clicked is still verified and recorded. Whatever's already done stays done.

## Safe Mode and Fast Mode

Two presets in the Advanced drawer.

| Setting | Safe Mode | Fast Mode |
|---|---|---|
| Session Target | 20 | unlimited |
| Daily Cap | 100 | 150 |
| Batch Size | 6 | 10 |
| Batch Delay | 300s | 90s |

Safe Mode is what I actually use. 20 follows per session, then stop. Instagram's soft limits kick in somewhere around 25-30 follows in a short window, and staying under that keeps the account clean. The 5-minute batch delay mirrors the platform's cooldown.

Fast Mode exists for people who want it, but it's genuinely aggressive. If you hit a soft block with Fast Mode, that's on the preset, not on the tool.

You can edit any value directly. The preset switches to "Custom" the moment you change something.

## Settings

Under the Advanced drawer:

- **Preset:** Safe, Fast, or Custom.
- **Session Target:** how many follows before the loop stops. 0 means unlimited.
- **Daily Cap:** maximum follows per day, and maximum unfollows per day. Counted separately.
- **Batch Size:** how many actions before a long pause.
- **Batch Delay:** how long that pause is, in seconds.
- **Show debug logs:** verbose output. Adds API pagination details, stall events and target parsing to the log. Off by default.
- **Manual blacklist input:** type a username and it goes straight into the blacklist.
- **Export / Clear Blacklist:** downloads the blacklist as JSON, and optionally wipes it.

## Data it stores

Everything lives in `localStorage`, keys prefixed with `sa_`:

| Key | Contents |
|---|---|
| `sa_blacklist` | Usernames you've unfollowed, followers you don't follow back, and manual entries |
| `sa_follow_history` | `{ username: timestamp }` for confirmed follows |
| `sa_pending_requests` | `{ username: timestamp }` for pending (private) requests |
| `sa_my_followers` | Who follows you, from the last sync |
| `sa_my_following` | Who you follow, from the last sync |
| `sa_following_seen` | `{ username: timestamp }` when each account first appeared in a Following sync (0 = already there before this feature) |
| `sa_daily_stats` | `{ date, follows, pending, unfollows }`, resets daily |
| `sa_settings` | Your preset and custom values |
| `sa_last_sync` | Timestamps of the last sync for each list |

To wipe everything, open the console and run `localStorage.clear()`. Note this also clears any other site data on instagram.com.

## Troubleshooting

**"Sync failed: NO_CSRF"** or **"API unavailable".** Instagram's session cookies weren't readable. Usually this means you're not logged in, or an extension is stripping cookies. Brave Shields is fine as-is (the cookies we need are first-party). Try a private window with extensions off to narrow it down. If the API is truly unreachable, the tool falls back to the DOM path automatically.

**"Refusing to run: Following list is empty".** You clicked Unfollow before syncing Following. Sync Following first, so the tool knows how long you've followed each account.

**"Refusing to run: Followers refresh via API failed".** The unfollow loop couldn't fetch a fresh Followers list, so it can't safely tell who's a mutual. Check that you're logged in, wait a few minutes, and try again.

**"RATE LIMIT DETECTED (Silent Rollback)".** Instagram is quietly reverting your follows. Stop for the day. Next time, try a lower Session Target, maybe 10 instead of 20.

**The panel disappeared after reload.** Console paste doesn't persist. Re-paste, or switch to Tampermonkey.

**"No modal found".** Open the Followers or Following modal in Instagram first, then click the button.

**A follow got counted as "pending".** That's a private account. Instagram is holding your request until they accept. It will be promoted to a real follow on your next Following sync if they accept.

## Project layout

```
instagram-automator/
  script.js       the whole tool
  README.md
  LICENSE
  .gitignore
```

No `package.json`, no build step, no dependencies.

## Contributing

Issues and PRs welcome. It's one file with no build system, so testing changes is easy: paste the modified script into your console and reload Instagram.

Two requests before you open a PR: run `node --check script.js` to verify syntax, and keep all user-facing strings in English.

## License

MIT. Do what you want, no warranty.

## Disclaimer

Not affiliated with Instagram or Meta. It's a browser-side script that talks to endpoints on the site you're already logged in to. You're responsible for how you use it.

