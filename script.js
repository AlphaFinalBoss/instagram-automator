/* =========================================================================
 * Instagram Automator v2.5
 * -------------------------------------------------------------------------
 * A self-contained, vanilla-JS console / userscript automator for
 * Instagram follow / unfollow workflows.
 *
 * No build step, no external dependencies. Paste into the browser console,
 * or load as a userscript. A floating control panel is injected into the
 * page automatically.
 *
 * Features
 *   - Direct Instagram API sync for Followers / Following lists (deterministic,
 *     no DOM scraping, no virtual-list timing issues).
 *   - DOM fallback if the API is unavailable (missing cookies, rate-limit).
 *   - Unfollow Non-Followers action that auto-blacklists each unfollowed
 *     account in one click.
 *   - Follow loop with human-like click simulation and randomized jitter.
 *   - Shadow rate-limit / silent-rollback detection with audio alert.
 *   - Unfollow loop that targets every non-follower (auto-blacklists each
 *     one) and always protects mutual followers.
 *   - Whitelist: accounts that are never unfollowed, even if they do not
 *     follow you back.
 *   - Persistent blacklist, follow/following history, per-day statistics.
 *     Follows, pending requests (private accounts), and unfollows are
 *     tracked separately. Pending requests are auto-reconciled on the
 *     next Following sync.
 *   - Configurable session target, daily cap, batch size and batch delay.
 *   - Safe Mode / Fast Mode presets.
 *   - 3-step guided UI (Sync, Blacklist, Automate) with optional verbose
 *     logging for debugging.
 *
 * License: MIT
 * ========================================================================= */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 0. GUARD & META                                                     */
  /* ------------------------------------------------------------------ */
  if (window.SA_Automator) return; // Prevent double injection.

  const VERSION = '2.5';
  const TITLE = 'Instagram Automator v' + VERSION;

  /* ------------------------------------------------------------------ */
  /* 1. CONFIG                                                           */
  /* ------------------------------------------------------------------ */
  // NOTE: these values are live - they are mutated by the settings drawer
  // and by preset selection at runtime.
  const CONFIG = {
    searchCycleDelay: 1000,        // Delay between list scans (ms).
    searchCycleWaitAfterFive: 8000,// Longer pause during scanning (ms).
    actionDelayMin: 3000,          // Minimum delay between actions (ms).
    actionDelayMax: 5500,          // Maximum delay between actions (ms), human jitter.
    waitAfterFiveActions: 150000,  // Pause after a full batch (ms). 150s default.
    actionsBatchSize: 6,           // Actions per batch before a long pause.
    maxDailyActions: 100,          // Daily action cap. Increase at your own risk.
    unfollowCooldownHours: 24,     // Minimum age before an account may be unfollowed.
    sessionTarget: 0,              // Follows for the current run. 0 = unlimited.
    followVerifyDelay: 1800        // Wait before verifying the follow state (ms).
  };

  // Presets. "custom" deliberately keeps whatever is currently configured.
  const PRESETS = {
    safe: { sessionTarget: 20, actionsBatchSize: 6, waitAfterFiveActions: 300000, maxDailyActions: 100 },
    fast: { sessionTarget: 0, actionsBatchSize: 10, waitAfterFiveActions: 90000, maxDailyActions: 150 },
    custom: null
  };

  // Persisted defaults for the settings drawer.
  const DEFAULT_SETTINGS = {
    preset: 'safe',
    sessionTarget: 20,
    maxDailyActions: 100,
    actionsBatchSize: 6,
    waitAfterFiveActions: 300000
  };

  // Text shown by the platform when an action has been throttled.
  const BLOCK_PHRASES = [
    'action blocked',
    'try again later',
    'limit reached',
    'temporarily blocked',
    'we restrict certain activity',
    'please wait a few minutes'
  ];

  // DOM selector groups. Add locale-specific labels here if your UI is not
  // in English.
  const SELECTORS = {
    dialog: ['div[role="dialog"]', 'div[role="presentation"] div[role="dialog"]'],
    scrollContainer: ['div[role="dialog"] ul', 'div[role="dialog"] div[style*="overflow"]'],
    followButtonText: ['Follow'],
    skippableButtonText: [
      'Following', 'Requested', 'Unfollow', 'Message', 'Edit Profile', 'Follow Back'
    ]
  };

  // Button labels that indicate a successful follow transition.
  const FOLLOW_SUCCESS_LABELS = ['requested', 'following'];
  // Labels that indicate the follow did NOT stick (silent rollback).
  const FOLLOW_FAILURE_LABELS = ['follow'];

  // Paths that are never user profiles and must be ignored during extraction.
  const RESERVED_PATHS = ['p', 'explore', 'reel', 'stories', 'accounts', 'direct', 'about', 'directory'];

  // Internal friendships API. Used to page through followers/following
  // deterministically (50 users per request) instead of scraping the
  // virtualized DOM list.
  const IG_API = {
    appId: '936619743392459',
    asbdId: '129477',
    count: 200,
    maxPages: 60
  };

  // Extract a username from an anchor href ("/someuser/" -> "someuser").
  // Returns null for links that are not profile permalinks.
  function usernameFromHref(href) {
    const clean = (href || '').replace(/^https?:\/\/[^\/]+/, '').split('?')[0].split('#')[0];
    const m = clean.match(/^\/([A-Za-z0-9._]+)\/?$/);
    if (m && m[1] && RESERVED_PATHS.indexOf(m[1]) === -1) return m[1];
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* 2. STATE MANAGEMENT (localStorage)                                  */
  /* ------------------------------------------------------------------ */
  const KEYS = {
    blacklist: 'sa_blacklist',
    whitelist: 'sa_whitelist',
    history: 'sa_follow_history',
    pending: 'sa_pending_requests',
    stats: 'sa_daily_stats',
    myFollowers: 'sa_my_followers',
    following: 'sa_my_following',
    followingSeen: 'sa_following_seen',
    lastSync: 'sa_last_sync',
    settings: 'sa_settings'
  };

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full / disabled */ }
  }

  function todayStr() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // Instagram usernames are case-insensitive; every comparison goes through this.
  function norm(username) {
    return String(username || '').trim().replace(/^@+/, '').toLowerCase();
  }

  function readNameSet(key) {
    const arr = readJSON(key, []);
    return new Set((Array.isArray(arr) ? arr : []).map(norm).filter(Boolean));
  }

  const Store = {
    /* ---- blacklist ---- */
    getBlacklist() {
      return readNameSet(KEYS.blacklist);
    },
    addBlacklist(username) {
      username = norm(username);
      if (!username) return;
      const set = Store.getBlacklist();
      set.add(username);
      writeJSON(KEYS.blacklist, Array.from(set));
    },
    addBlacklistMany(usernames) {
      const set = Store.getBlacklist();
      const before = set.size;
      for (const u of usernames) { const n = norm(u); if (n) set.add(n); }
      if (set.size !== before) writeJSON(KEYS.blacklist, Array.from(set));
      return set.size - before;
    },
    removeBlacklist(username) {
      const set = Store.getBlacklist();
      const had = set.delete(norm(username));
      writeJSON(KEYS.blacklist, Array.from(set));
      return had;
    },
    clearBlacklist() {
      writeJSON(KEYS.blacklist, []);
    },

    /* ---- whitelist (never unfollowed) ---- */
    getWhitelist() {
      return readNameSet(KEYS.whitelist);
    },
    addWhitelist(username) {
      username = norm(username);
      if (!username) return;
      const set = Store.getWhitelist();
      set.add(username);
      writeJSON(KEYS.whitelist, Array.from(set));
    },
    removeWhitelist(username) {
      const set = Store.getWhitelist();
      const had = set.delete(norm(username));
      writeJSON(KEYS.whitelist, Array.from(set));
      return had;
    },

    /* ---- mutual followers (accounts that follow me) ---- */
    getMyFollowers() {
      return readNameSet(KEYS.myFollowers);
    },
    setMyFollowers(array) {
      const arr = Array.isArray(array) ? array : Array.from(array || []);
      writeJSON(KEYS.myFollowers, arr);
      return arr;
    },

    getMyFollowing() {
      return readNameSet(KEYS.following);
    },
    setMyFollowing(array) {
      const arr = Array.isArray(array) ? array : Array.from(array || []);
      Store.updateFollowingSeen(arr);
      writeJSON(KEYS.following, arr);
      return arr;
    },
    // Drop one account after an unfollow, without touching followingSeen
    // (the next sync prunes it there).
    removeFollowing(username) {
      const set = Store.getMyFollowing();
      if (set.delete(norm(username))) writeJSON(KEYS.following, Array.from(set));
    },

    /* ---- first time each followed account appeared in a Following sync ---- */
    // Catches follows made outside the script (manually, from the phone),
    // so they get the same unfollow cooldown as script follows.
    getFollowingSeen() {
      const obj = readJSON(KEYS.followingSeen, null);
      return obj && typeof obj === 'object' ? obj : null;
    },
    updateFollowingSeen(currentFollowing) {
      let seen = Store.getFollowingSeen();
      const now = Date.now();
      if (!seen) {
        // First run with this feature: accounts already in the previous sync
        // are treated as old (0); anything new since then starts its clock now.
        const previous = Store.getMyFollowing();
        seen = {};
        for (const u of currentFollowing) seen[norm(u)] = previous.size && !previous.has(norm(u)) ? now : 0;
      } else {
        const next = {};
        for (const u of currentFollowing) {
          const k = norm(u);
          next[k] = typeof seen[k] === 'number' ? seen[k] : now;
        }
        seen = next;
      }
      writeJSON(KEYS.followingSeen, seen);
    },

    getLastSync() {
      const obj = readJSON(KEYS.lastSync, {});
      return obj && typeof obj === 'object' ? obj : {};
    },
    setLastSync(kind, ts) {
      const obj = Store.getLastSync();
      obj[kind] = ts;
      writeJSON(KEYS.lastSync, obj);
      return obj;
    },

    /* ---- follow history (username -> timestamp) ---- */
    getHistory() {
      const obj = readJSON(KEYS.history, {});
      return obj && typeof obj === 'object' ? obj : {};
    },
    setFollow(username, ts) {
      username = norm(username);
      if (!username) return;
      const h = Store.getHistory();
      h[username] = typeof ts === 'number' ? ts : Date.now();
      writeJSON(KEYS.history, h);
    },
    removeHistory(username) {
      const h = Store.getHistory();
      delete h[norm(username)];
      writeJSON(KEYS.history, h);
    },

    getPendingRequests() {
      const obj = readJSON(KEYS.pending, {});
      return obj && typeof obj === 'object' ? obj : {};
    },
    setPendingRequest(username) {
      username = norm(username);
      if (!username) return;
      const p = Store.getPendingRequests();
      p[username] = Date.now();
      writeJSON(KEYS.pending, p);
    },
    removePendingRequest(username) {
      const p = Store.getPendingRequests();
      const k = norm(username);
      if (p[k]) {
        delete p[k];
        writeJSON(KEYS.pending, p);
      }
    },
    clearPendingRequests() {
      writeJSON(KEYS.pending, {});
    },

    /* ---- daily statistics ---- */
    getStats() {
      let stats = readJSON(KEYS.stats, null);
      const today = todayStr();
      if (!stats || stats.date !== today) {
        stats = { date: today, follows: 0, pending: 0, unfollows: 0 };
        writeJSON(KEYS.stats, stats);
        return stats;
      }
      if (typeof stats.follows !== 'number' || typeof stats.unfollows !== 'number' || typeof stats.pending !== 'number') {
        const legacyCount = typeof stats.count === 'number' ? stats.count : 0;
        stats.follows = typeof stats.follows === 'number' ? stats.follows : 0;
        stats.pending = typeof stats.pending === 'number' ? stats.pending : 0;
        stats.unfollows = typeof stats.unfollows === 'number' ? stats.unfollows : legacyCount;
        delete stats.count;
        writeJSON(KEYS.stats, stats);
      }
      return stats;
    },
    incrementFollows() {
      const stats = Store.getStats();
      stats.follows += 1;
      writeJSON(KEYS.stats, stats);
      return stats.follows;
    },
    incrementPending() {
      const stats = Store.getStats();
      stats.pending += 1;
      writeJSON(KEYS.stats, stats);
      return stats.pending;
    },
    incrementUnfollows() {
      const stats = Store.getStats();
      stats.unfollows += 1;
      writeJSON(KEYS.stats, stats);
      return stats.unfollows;
    },

    /* ---- settings ---- */
    getSettings() {
      const saved = readJSON(KEYS.settings, {});
      return Object.assign({}, DEFAULT_SETTINGS, saved && typeof saved === 'object' ? saved : {});
    },
    setSettings(settings) {
      writeJSON(KEYS.settings, Object.assign({}, DEFAULT_SETTINGS, settings));
    }
  };

  /* ------------------------------------------------------------------ */
  /* 3. FLOATING UI WIDGET                                               */
  /* ------------------------------------------------------------------ */
  const UI = (function () {
    let panel, logBox, statusLine, todayLine, countdownLine, warningLine;
    let followBtn, unfollowBtn, stopBtn, blackBtn, settingsToggle, settingsBox;
    let syncFollowersBtn, syncFollowingBtn, advancedToggle, advancedBox, syncStatusLine, networkLine;
    let presetSelect, sessionTargetInput, dailyCapInput, batchSizeInput, batchDelayInput, capWarning;
    let maxLogs = 60;

    function style(el, obj) {
      Object.assign(el.style, obj);
    }

    function build() {
      if (document.getElementById('sa-panel')) return;

      panel = document.createElement('div');
      panel.id = 'sa-panel';
      style(panel, {
        position: 'fixed',
        top: '16px',
        right: '16px',
        width: '300px',
        zIndex: '9999999',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: '12px',
        background: '#16181d',
        color: '#e6e6e6',
        border: '1px solid #2c2f36',
        borderRadius: '12px',
        boxShadow: '0 8px 30px rgba(0,0,0,.55)',
        padding: '12px',
        boxSizing: 'border-box',
        maxHeight: 'calc(100vh - 32px)',
        overflowY: 'auto',
        userSelect: 'none'
      });

      /* ---- header ---- */
      const header = document.createElement('div');
      style(header, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px', cursor: 'move' });
      const title = document.createElement('div');
      title.textContent = TITLE;
      style(title, { fontWeight: '700', fontSize: '13px', letterSpacing: '.2px' });
      const minimize = document.createElement('div');
      minimize.textContent = '\u2013';
      style(minimize, { cursor: 'pointer', padding: '0 6px', color: '#8b93a1' });
      header.appendChild(title);
      header.appendChild(minimize);
      panel.appendChild(header);

      /* ---- status block ---- */
      statusLine = document.createElement('div');
      style(statusLine, { marginBottom: '4px', color: '#9fe6b3', minHeight: '15px', lineHeight: '1.35' });
      networkLine = document.createElement('div');
      style(networkLine, { marginBottom: '4px', color: '#c7ccd6', lineHeight: '1.35' });
      networkLine.textContent = 'Following: -  \u00b7  Followers: -';
      todayLine = document.createElement('div');
      style(todayLine, { marginBottom: '4px', color: '#8b93a1' });
      panel.appendChild(statusLine);
      panel.appendChild(networkLine);
      panel.appendChild(todayLine);

      /* ---- STEP 1: sync your lists ---- */
      const step1Block = document.createElement('div');
      step1Block.appendChild(mkSectionTitle('STEP 1 \u00b7 SYNC YOUR LISTS'));
      const syncWrap = document.createElement('div');
      style(syncWrap, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' });
      syncFollowersBtn = mkButton('[Sync Followers]', '#2563eb');
      syncFollowingBtn = mkButton('[Sync Following]', '#2563eb');
      syncWrap.appendChild(syncFollowersBtn);
      syncWrap.appendChild(syncFollowingBtn);
      step1Block.appendChild(syncWrap);
      syncStatusLine = document.createElement('div');
      style(syncStatusLine, { color: '#8b93a1', fontSize: '10px', marginTop: '4px' });
      syncStatusLine.textContent = 'Followers: never \u00b7 Following: never';
      step1Block.appendChild(syncStatusLine);
      panel.appendChild(step1Block);

      /* ---- STEP 2: automate ---- */
      const step3Block = document.createElement('div');
      step3Block.appendChild(mkSectionTitle('STEP 2 \u00b7 AUTOMATE'));
      const actWrap = document.createElement('div');
      style(actWrap, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' });
      followBtn = mkButton('[Start Follow Loop]', '#1f9d55');
      unfollowBtn = mkButton('[Unfollow Non-Followers]', '#d97706');
      actWrap.appendChild(followBtn);
      actWrap.appendChild(unfollowBtn);
      step3Block.appendChild(actWrap);
      panel.appendChild(step3Block);

      /* ---- stop (full width, red) ---- */
      stopBtn = mkButton('[Stop / Pause]', '#c53030');
      style(stopBtn, { width: '100%', marginTop: '8px' });
      panel.appendChild(stopBtn);

      /* ---- advanced toggle + drawer ---- */
      advancedToggle = mkButton('[\u25be Advanced]', '#334155');
      style(advancedToggle, { width: '100%', marginTop: '6px', opacity: '0.8' });
      panel.appendChild(advancedToggle);

      advancedBox = document.createElement('div');
      style(advancedBox, {
        display: 'none', background: '#0d0f12', border: '1px solid #23262d',
        borderRadius: '8px', padding: '8px', marginTop: '6px',
        maxHeight: '55vh', overflowY: 'auto', paddingRight: '4px'
      });

      settingsToggle = mkButton('[Settings]', '#475569');
      style(settingsToggle, { width: '100%', marginBottom: '6px' });

      const advancedRow = document.createElement('div');
      style(advancedRow, { marginBottom: '6px' });
      const verboseCheckbox = document.createElement('input');
      verboseCheckbox.type = 'checkbox';
      verboseCheckbox.id = 'sa-verbose';
      const verboseLabel = document.createElement('label');
      verboseLabel.htmlFor = 'sa-verbose';
      verboseLabel.textContent = 'Show debug logs';
      style(verboseLabel, { color: '#8b93a1', fontSize: '10px', marginLeft: '6px', cursor: 'pointer' });
      verboseCheckbox.addEventListener('change', function () { setVerbose(verboseCheckbox.checked); });
      advancedRow.appendChild(verboseCheckbox);
      advancedRow.appendChild(verboseLabel);

      blackBtn = mkButton('[Export / Clear Blacklist]', '#334155');
      style(blackBtn, { width: '100%' });

      settingsBox = buildSettingsBox();

      /* ---- manual blacklist / whitelist (by username) ---- */
      const listsLine = document.createElement('div');
      style(listsLine, { color: '#8b93a1', fontSize: '10px', marginTop: '6px' });
      function updateListCounts() {
        listsLine.textContent = 'Whitelist (never unfollow): ' + Store.getWhitelist().size +
          '  \u00b7  Blacklist (never follow): ' + Store.getBlacklist().size;
      }
      const wlWrap = mkUsernameRow('Whitelist', '#0f766e', Store.addWhitelist, Store.removeWhitelist, updateListCounts);
      const blWrap = mkUsernameRow('Blacklist', '#475569', Store.addBlacklist, Store.removeBlacklist, updateListCounts);
      updateListCounts();
      advancedToggle.addEventListener('click', updateListCounts);

      advancedBox.appendChild(settingsToggle);
      advancedBox.appendChild(settingsBox);
      advancedBox.appendChild(blackBtn);
      advancedBox.appendChild(advancedRow);
      advancedBox.appendChild(listsLine);
      advancedBox.appendChild(wlWrap);
      advancedBox.appendChild(blWrap);
      panel.appendChild(advancedBox);

      /* ---- countdown / warning ---- */
      countdownLine = document.createElement('div');
      style(countdownLine, { marginTop: '6px', marginBottom: '6px', color: '#ffd166', fontWeight: '600' });
      warningLine = document.createElement('div');
      style(warningLine, {
        marginBottom: '6px', color: '#ff5c5c', fontWeight: '700', display: 'none',
        background: 'rgba(255,92,92,.12)', border: '1px solid rgba(255,92,92,.4)',
        borderRadius: '6px', padding: '6px', lineHeight: '1.35'
      });
      panel.appendChild(countdownLine);
      panel.appendChild(warningLine);

      /* ---- log box ---- */
      logBox = document.createElement('div');
      style(logBox, {
        maxHeight: '150px', overflowY: 'auto', background: '#0d0f12',
        border: '1px solid #23262d', borderRadius: '8px', padding: '6px',
        lineHeight: '1.4', color: '#c7ccd6', whiteSpace: 'pre-wrap'
      });
      panel.appendChild(logBox);
      document.body.appendChild(panel);

      makeDraggable(panel, header);

      minimize.addEventListener('click', function () {
        const collapsed = logBox.style.display === 'none';
        logBox.style.display = collapsed ? 'block' : 'none';
        minimize.textContent = collapsed ? '\u2013' : '+';
      });

      settingsToggle.addEventListener('click', function () {
        const open = settingsBox.style.display === 'block';
        settingsBox.style.display = open ? 'none' : 'block';
        settingsToggle.textContent = open ? '[Settings]' : '[Hide Settings]';
      });
    }

    // Input + Add / Remove for a username list. Accepts several names at
    // once, separated by spaces, commas or new lines.
    function mkUsernameRow(label, color, add, remove, onChange) {
      const wrap = document.createElement('div');
      style(wrap, { display: 'flex', gap: '6px', marginTop: '6px' });
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = label.toLowerCase() + ': username without @';
      style(input, {
        background: '#0d0f12', padding: '5px', border: '1px solid #334155',
        borderRadius: '6px', color: '#fff', width: '55%', boxSizing: 'border-box', fontSize: '11px'
      });
      const mkSmall = (text, bg) => {
        const b = document.createElement('button');
        b.textContent = text;
        style(b, {
          background: bg, color: '#fff', border: 'none', padding: '5px',
          borderRadius: '6px', fontWeight: '600', cursor: 'pointer', fontSize: '11px', flex: '1'
        });
        return b;
      };
      const addBtn = mkSmall('+ ' + label, color);
      const removeBtn = mkSmall('\u2212', '#334155');
      removeBtn.title = 'Remove from ' + label.toLowerCase();
      style(removeBtn, { flex: '0 0 28px' });
      const names = () => input.value.split(/[\s,]+/).map(norm).filter(Boolean);
      function doAdd() {
        const list = names();
        if (!list.length) return;
        list.forEach(u => add(u));
        log(label + ' + ' + list.join(', '));
        input.value = '';
        onChange();
      }
      function doRemove() {
        const list = names();
        if (!list.length) return;
        list.forEach(u => log(remove(u) ? label + ' - ' + u : u + ' was not in the ' + label.toLowerCase()));
        input.value = '';
        onChange();
      }
      addBtn.addEventListener('click', doAdd);
      removeBtn.addEventListener('click', doRemove);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); doAdd(); }
      });
      wrap.appendChild(input);
      wrap.appendChild(addBtn);
      wrap.appendChild(removeBtn);
      return wrap;
    }

    function mkSectionTitle(text) {
      const d = document.createElement('div');
      d.textContent = text;
      style(d, { color: '#8b93a1', fontSize: '10px', letterSpacing: '.5px', margin: '8px 0 4px' });
      return d;
    }

    /* ---- settings drawer construction ---- */
    function buildSettingsBox() {
      const box = document.createElement('div');
      style(box, {
        display: 'none', background: '#0d0f12', border: '1px solid #23262d',
        borderRadius: '8px', padding: '8px', marginBottom: '8px'
      });

      presetSelect = document.createElement('select');
      [['safe', 'Safe Mode (Recommended)'], ['fast', 'Fast Mode (Aggressive)'], ['custom', 'Custom']]
        .forEach(([value, label]) => {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = label;
          presetSelect.appendChild(opt);
        });
      styleInput(presetSelect);
      presetSelect.addEventListener('change', () => applyPreset(presetSelect.value, true));
      box.appendChild(mkField('Preset', presetSelect));

      sessionTargetInput = mkNumberInput(0, 0);
      sessionTargetInput.addEventListener('change', () => { markCustom(); onSettingsChanged(); });
      box.appendChild(mkField('Session Target (follows, 0 = unlimited)', sessionTargetInput));

      capWarning = document.createElement('span');
      capWarning.textContent = ' (At your own risk)';
      style(capWarning, { color: '#ffb454', fontWeight: '600', display: 'none' });
      dailyCapInput = mkNumberInput(1, 1);
      dailyCapInput.addEventListener('input', () => { markCustom(); updateCapWarning(); onSettingsChanged(); });
      const capField = mkField('Daily Cap', dailyCapInput);
      capField.appendChild(capWarning);
      box.appendChild(capField);

      batchSizeInput = mkNumberInput(1, 1);
      batchSizeInput.addEventListener('change', () => { markCustom(); onSettingsChanged(); });
      box.appendChild(mkField('Batch Size (actions)', batchSizeInput));

      batchDelayInput = mkNumberInput(0, 0);
      batchDelayInput.addEventListener('change', () => { markCustom(); onSettingsChanged(); });
      box.appendChild(mkField('Batch Delay (seconds)', batchDelayInput));

      return box;
    }

    function mkField(labelText, inputEl) {
      const wrap = document.createElement('div');
      style(wrap, { marginBottom: '6px' });
      const label = document.createElement('div');
      label.textContent = labelText;
      style(label, { color: '#8b93a1', marginBottom: '3px', fontSize: '10px' });
      wrap.appendChild(label);
      wrap.appendChild(inputEl);
      return wrap;
    }

    function mkNumberInput(value, min) {
      const input = document.createElement('input');
      input.type = 'number';
      input.value = String(value);
      if (typeof min === 'number') input.min = String(min);
      styleInput(input);
      return input;
    }

    function styleInput(input) {
      style(input, {
        background: '#16181d', padding: '5px', border: '1px solid #334155',
        borderRadius: '6px', color: '#fff', width: '100%',
        boxSizing: 'border-box', fontSize: '11px'
      });
    }

    /* ---- settings <-> config ---- */
    function markCustom() {
      if (presetSelect) presetSelect.value = 'custom';
    }

    function onSettingsChanged() {
      const settings = collectSettings();
      Store.setSettings(settings);
      applySettingsToConfig(settings);
      updateCapWarning();
      updateToday();
    }

    function applyPreset(name, persist) {
      const preset = PRESETS[name];
      if (preset) {
        if (typeof preset.sessionTarget === 'number' && sessionTargetInput) {
          sessionTargetInput.value = String(preset.sessionTarget);
        }
        batchSizeInput.value = String(preset.actionsBatchSize);
        batchDelayInput.value = String(Math.round(preset.waitAfterFiveActions / 1000));
        dailyCapInput.value = String(preset.maxDailyActions);
      }
      if (presetSelect) presetSelect.value = name;
      if (persist !== false) onSettingsChanged();
    }

    function collectSettings() {
      return {
        preset: presetSelect ? presetSelect.value : DEFAULT_SETTINGS.preset,
        sessionTarget: readInt(sessionTargetInput, 0),
        maxDailyActions: readInt(dailyCapInput, 100),
        actionsBatchSize: readInt(batchSizeInput, 6),
        waitAfterFiveActions: readInt(batchDelayInput, 150) * 1000
      };
    }

    function applySettingsToConfig(settings) {
      CONFIG.sessionTarget = settings.sessionTarget;
      CONFIG.maxDailyActions = settings.maxDailyActions;
      CONFIG.actionsBatchSize = settings.actionsBatchSize;
      CONFIG.waitAfterFiveActions = settings.waitAfterFiveActions;
    }

    function readInt(input, fallback) {
      if (!input) return fallback;
      const n = parseInt(input.value, 10);
      return isNaN(n) ? fallback : n;
    }

    function updateCapWarning() {
      if (!capWarning || !dailyCapInput) return;
      capWarning.style.display = readInt(dailyCapInput, 0) > 100 ? 'inline' : 'none';
    }

    /* ---- load / sync settings from storage into the UI ---- */
    function loadSettings() {
      const settings = Store.getSettings();
      if (presetSelect) presetSelect.value = settings.preset || DEFAULT_SETTINGS.preset;
      if (sessionTargetInput) sessionTargetInput.value = String(settings.sessionTarget);
      if (dailyCapInput) dailyCapInput.value = String(settings.maxDailyActions);
      if (batchSizeInput) batchSizeInput.value = String(settings.actionsBatchSize);
      if (batchDelayInput) batchDelayInput.value = String(Math.round(settings.waitAfterFiveActions / 1000));
      applySettingsToConfig(settings);
      updateCapWarning();
    }

    function mkButton(label, color) {
      const b = document.createElement('button');
      b.textContent = label;
      style(b, {
        background: color, color: '#fff', border: 'none', borderRadius: '7px',
        padding: '7px 6px', fontSize: '11px', cursor: 'pointer', fontWeight: '600'
      });
      b.addEventListener('mouseenter', () => { b.style.opacity = '0.85'; });
      b.addEventListener('mouseleave', () => { b.style.opacity = '1'; });
      return b;
    }

    function makeDraggable(el, handle) {
      let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
      handle.addEventListener('mousedown', e => {
        dragging = true;
        sx = e.clientX; sy = e.clientY;
        const r = el.getBoundingClientRect();
        ox = r.left; oy = r.top;
        el.style.right = 'auto';
        el.style.left = ox + 'px';
        el.style.top = oy + 'px';
        e.preventDefault();
      });
      document.addEventListener('mousemove', e => {
        if (!dragging) return;
        el.style.left = (ox + e.clientX - sx) + 'px';
        el.style.top = (oy + e.clientY - sy) + 'px';
      });
      document.addEventListener('mouseup', () => { dragging = false; });
    }

    function setStatus(text) { if (statusLine) statusLine.textContent = text; }
    function setCountdown(text) { if (countdownLine) countdownLine.textContent = text || ''; }
    function setWarning(text) {
      if (!warningLine) return;
      warningLine.textContent = text || '';
      warningLine.style.display = text ? 'block' : 'none';
    }
    function updateToday() {
      const s = Store.getStats();
      if (todayLine) {
        todayLine.textContent = 'Today: ' + s.follows + '/' + CONFIG.maxDailyActions + ' follows  \u00b7  ' + s.pending + ' pending  \u00b7  ' + s.unfollows + ' unfollows';
      }
      updateNetworkCounts();
      updateSyncStatus();
    }

    function updateNetworkCounts() {
      const f = Store.getMyFollowers().size;
      const g = Store.getMyFollowing().size;
      const nf = g > 0 && f > 0 ? Math.max(0, g - f) : 0;
      if (networkLine) {
        networkLine.textContent = 'Following: ' + (g || '-') + '  \u00b7  Followers: ' + (f || '-') + (nf ? '  \u00b7  Non-followers: ' + nf : '');
      }
    }
    function updateSyncStatus() {
      if (!syncStatusLine) return;
      const s = Store.getLastSync();
      const fmt = ts => {
        if (!ts) return 'never';
        const d = Math.floor((Date.now() - ts) / 1000);
        if (d < 60) return d + 's ago';
        if (d < 3600) return Math.floor(d / 60) + 'm ago';
        if (d < 86400) return Math.floor(d / 3600) + 'h ago';
        return Math.floor(d / 86400) + 'd ago';
      };
      syncStatusLine.textContent = 'Followers: ' + fmt(s.followers) + ' \u00b7 Following: ' + fmt(s.following);
    }

    let verbose = false;
    function setVerbose(on) { verbose = !!on; if (logBox) logBox.style.borderColor = verbose ? '#4d6bfe' : '#23262d'; }
    function isVerbose() { return verbose; }

    function log(msg) {
      appendLog(msg, false);
    }
    function logDebug(msg) {
      if (!verbose) return;
      appendLog(msg, true);
    }
    function appendLog(msg, isDebug) {
      if (!logBox) return;
      const t = new Date().toLocaleTimeString();
      const line = document.createElement('div');
      line.textContent = '[' + t + '] ' + msg;
      if (isDebug) line.style.color = '#6b7280';
      logBox.appendChild(line);
      while (logBox.childNodes.length > maxLogs) logBox.removeChild(logBox.firstChild);
      logBox.scrollTop = logBox.scrollHeight;
    }

    return {
      build, loadSettings, applyPreset, setStatus, setCountdown, setWarning, updateToday, log,
      setVerbose, isVerbose, logDebug, updateNetworkCounts, updateSyncStatus,
      get advancedBox() { return advancedBox; },
      buttons: {
        get follow() { return followBtn; },
        get unfollow() { return unfollowBtn; },
        get stop() { return stopBtn; },
        get black() { return blackBtn; },
        get syncFollowers() { return syncFollowersBtn; },
        get syncFollowing() { return syncFollowingBtn; },
        get advancedToggle() { return advancedToggle; }
      }
    };
  })();

  /* ------------------------------------------------------------------ */
  /* 4. AUDIO ALERT                                                      */
  /* ------------------------------------------------------------------ */
  function beep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
      setTimeout(() => { try { ctx.close(); } catch (e) { /* noop */ } }, 600);
    } catch (e) { /* audio unavailable */ }
  }

  /* ------------------------------------------------------------------ */
  /* 5. AUTOMATOR CORE                                                   */
  /* ------------------------------------------------------------------ */
  const Automator = {
    stopped: false,
    running: false,
    lastBlockCheck: 0,

    /* ---- DOM helpers ---- */
    findDialog() {
      for (const sel of SELECTORS.dialog) {
        const els = document.querySelectorAll(sel);
        if (els.length) return els[els.length - 1];
      }
      return null;
    },

    findScrollContainer(dialog) {
      if (!dialog) return null;
      const candidates = dialog.querySelectorAll('ul, div');
      let best = null, bestArea = 0;
      for (const el of candidates) {
        const overflowY = getComputedStyle(el).overflowY;
        if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 20) {
          const area = el.clientWidth * el.clientHeight;
          if (area > bestArea) { bestArea = area; best = el; }
        }
      }
      return best || dialog.querySelector('ul') || dialog;
    },

    getButtons(scope, texts) {
      const all = (scope || document).querySelectorAll('button, div[role="button"]');
      const wanted = texts.map(t => t.toLowerCase());
      const out = [];
      all.forEach(b => {
        const txt = (b.textContent || '').trim().toLowerCase();
        if (wanted.indexOf(txt) !== -1) out.push(b);
      });
      return out;
    },

    // Best-effort extraction of a username from a button's surrounding DOM.
    usernameFor(el) {
      let node = el;
      let depth = 0;
      while (node && depth < 8) {
        const anchors = node.querySelectorAll ? node.querySelectorAll('a[href]') : [];
        for (const a of anchors) {
          const username = usernameFromHref(a.getAttribute('href'));
          if (username) return username;
        }
        const imgs = node.querySelectorAll ? node.querySelectorAll('img[alt]') : [];
        for (const img of imgs) {
          const alt = (img.getAttribute('alt') || '').trim();
          if (alt && alt.toLowerCase().indexOf('profile') === -1 && alt.length < 40) return alt.replace(/\s+/g, '');
        }
        const spans = node.querySelectorAll ? node.querySelectorAll('span') : [];
        for (const s of spans) {
          const t = (s.textContent || '').trim();
          if (t && t.length < 40 && t.indexOf(' ') === -1 && !/^(follow|following|requested|unfollow)$/i.test(t)) {
            if (s.querySelector('a[href]') || (s.parentElement && s.parentElement.querySelector('a[href]'))) return t;
          }
        }
        node = node.parentElement; depth++;
      }
      return null;
    },

    randomDelay() {
      const span = CONFIG.actionDelayMax - CONFIG.actionDelayMin;
      return CONFIG.actionDelayMin + Math.floor(Math.random() * span);
    },

    /* ---- scroll reset (virtualization compliant) ---- */
    // Snap the list back to the very top and give React time to mount and
    // paint the first batch of rows before any scanning/actioning begins.
    async resetToTop(scroller, settle) {
      if (!scroller) return;
      try {
        scroller.scrollTop = 0;
      } catch (e) { /* detached node */ }
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await Automator.sleep(typeof settle === 'number' ? settle : 500, 'Mounting');
    },

    /* ---- micro-scroll (virtualization compliant) ---- */
    // The list is virtualized: rows are unmounted once scrolled out of view
    // and only remounted by the framework. Jumping hundreds of pixels skips
    // rows before React can evaluate them, so we advance in tiny 200px steps
    // (roughly 3-4 rows) and let the list settle afterwards.
    async microScroll(scroller, amount, settle) {
      if (!scroller) return false;
      const step = typeof amount === 'number' ? amount : 200;
      const settleMs = typeof settle === 'number' ? settle : 350;
      const before = scroller.scrollTop;
      scroller.scrollTop = before + step;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      try {
        scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: step }));
      } catch (e) { /* WheelEvent unavailable */ }
      await Automator.sleep(settleMs, 'Scroll');
      return scroller.scrollTop !== before;
    },

    /* ---- bidirectional jiggle for loaders that stall at the bottom ---- */
    async jiggleScroll(scroller) {
      if (!scroller) return;
      scroller.scrollTop = Math.max(0, scroller.scrollTop - 100);
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await Automator.sleep(200, 'Jiggle up');
      scroller.scrollTop += 150;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await Automator.sleep(200, 'Jiggle down');
    },

    /* ---- natural human-like click (pointer cascade + micro-jitter) ---- */
    simulateHumanClick(el) {
      if (!el) return;
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* noop */ }
      const rect = el.getBoundingClientRect();
      const jitter = () => (Math.random() - 0.5) * 8;
      const x = rect.left + rect.width / 2 + jitter();
      const y = rect.top + rect.height / 2 + jitter();
      const base = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button: 0,
        buttons: 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      };
      const fire = (type, Ctor, extra) => {
        let ev;
        try {
          ev = new Ctor(type, Object.assign({}, base, extra || {}));
        } catch (e) {
          ev = document.createEvent('MouseEvents');
          ev.initMouseEvent(type, true, true, window, 0, x, y, x, y, false, false, false, false, 0, null);
        }
        el.dispatchEvent(ev);
      };
      fire('pointerover', window.PointerEvent || MouseEvent);
      fire('mouseover', MouseEvent);
      fire('pointerdown', window.PointerEvent || MouseEvent);
      fire('mousedown', MouseEvent);
      fire('pointerup', window.PointerEvent || MouseEvent, { buttons: 0 });
      fire('mouseup', MouseEvent, { buttons: 0 });
      fire('click', MouseEvent, { buttons: 0, detail: 1 });
    },

    /* ---- blocking / safety ---- */
    checkBlocked() {
      const now = Date.now();
      if (now - Automator.lastBlockCheck < 1500) return false;
      Automator.lastBlockCheck = now;
      // Skip our own panel: its log quotes the block phrases, which would
      // otherwise re-trigger a stop on every later run.
      let text = '';
      for (const child of document.body.children) {
        if (child.id === 'sa-panel') continue;
        text += ' ' + (child.innerText || '');
      }
      text = text.toLowerCase();
      for (const phrase of BLOCK_PHRASES) {
        if (text.indexOf(phrase) !== -1) {
          Automator.triggerBlock(phrase);
          return true;
        }
      }
      return false;
    },

    triggerBlock(phrase) {
      Automator.stop();
      UI.setWarning('ACTION BLOCKED detected: "' + phrase + '". Auto-stopped to protect the account.');
      UI.setStatus('STOPPED for safety.');
      UI.log('!!! Block detected: "' + phrase + '" -> instant stop.');
      beep();
    },

    // Shadow rate-limit / silent rollback: the platform quietly reverts the
    // follow state instead of showing a hard block.
    triggerRateLimit(detail) {
      Automator.stop();
      UI.setWarning('RATE LIMIT DETECTED (Silent Rollback). Auto-stopping to protect account.');
      UI.setStatus('STOPPED for safety (rate limit).');
      UI.log('!!! Silent rollback detected' + (detail ? ' (' + detail + ')' : '') + ' -> instant stop.');
      beep();
      setTimeout(beep, 400);
    },

    /* ---- interruptible sleep with live countdown ---- */
    sleep(ms, label) {
      return new Promise(resolve => {
        const start = Date.now();
        const tick = () => {
          if (Automator.stopped) { UI.setCountdown(''); return resolve(); }
          const remaining = ms - (Date.now() - start);
          if (remaining <= 0) { UI.setCountdown(''); return resolve(); }
          const secs = Math.ceil(remaining / 1000);
          UI.setCountdown((label || 'Wait') + ': ' + secs + 's');
          setTimeout(tick, 250);
        };
        tick();
      });
    },

    /* ---- limits ---- */
    dailyCapReached(kind) {
      const s = Store.getStats();
      const used = kind === 'unfollows' ? s.unfollows : s.follows;
      if (used >= CONFIG.maxDailyActions) {
        UI.setStatus('Daily cap reached (' + used + '/' + CONFIG.maxDailyActions + ' ' + kind + '). Stopping.');
        UI.log('Daily cap reached for ' + kind + '. Stopping.');
        return true;
      }
      return false;
    },

    sessionTargetReached(done) {
      const target = CONFIG.sessionTarget;
      if (target > 0 && done >= target) {
        UI.setStatus('Session target reached (' + done + '/' + target + '). Stopping.');
        UI.log('Session target reached: ' + done + ' follows. Stopping run.');
        Automator.stop();
        return true;
      }
      return false;
    },

    /* ---- after every N actions: long batch pause ---- */
    async batchPause(actionCount) {
      if (actionCount > 0 && actionCount % CONFIG.actionsBatchSize === 0) {
        const seconds = Math.round(CONFIG.waitAfterFiveActions / 1000);
        UI.log('Batch of ' + CONFIG.actionsBatchSize + ' actions reached -> ' + seconds + 's pause.');
        UI.setStatus('Safety pause (' + seconds + 's)...');
        await Automator.sleep(CONFIG.waitAfterFiveActions, 'Batch pause');
        if (!Automator.stopped) UI.setStatus('Resuming...');
      }
    },

    /* ---- follow-state verification ---- */
    findFollowStateButton(username) {
      if (!username) return null;
      const scope = Automator.findDialog() || document;
      const buttons = scope.querySelectorAll('button, div[role="button"]');
      const labels = FOLLOW_SUCCESS_LABELS.concat(FOLLOW_FAILURE_LABELS, ['follow back']);
      for (const b of buttons) {
        const txt = (b.textContent || '').trim().toLowerCase();
        if (labels.indexOf(txt) === -1) continue;
        if (norm(Automator.usernameFor(b)) === norm(username)) return b;
      }
      return null;
    },

    // Plain wait that Stop cannot cut short. Used after a click has already
    // been sent, so the result is always recorded even if Stop is pressed.
    wait(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },

    // Returns { success, text }. Success requires the button to have settled
    // on "Requested" or "Following"; anything else means the follow silently
    // rolled back.
    resolveFollowState(button, username) {
      let el = (button && button.isConnected) ? button : Automator.findFollowStateButton(username);
      const text = el ? (el.textContent || '').trim().toLowerCase() : '';
      return { success: FOLLOW_SUCCESS_LABELS.indexOf(text) !== -1, text: text };
    },

    /* ---- perform one follow ---- */
    async doFollow(button, username) {
      username = norm(username);
      if (!username) return 0;

      const blacklist = Store.getBlacklist();
      if (blacklist.has(username)) { UI.log('SKIP (blacklist): ' + username); return 0; }
      const history = Store.getHistory();
      if (history[username]) { UI.log('SKIP (already followed): ' + username); return 0; }
      const pending = Store.getPendingRequests();
      if (pending[username]) { UI.log('SKIP (already requested): ' + username); return 0; }

      Automator.simulateHumanClick(button);

      // The click is out; always verify and record it, even if Stop is pressed
      // meanwhile. A follow that is not recorded has no cooldown protection.
      UI.setCountdown('Verifying...');
      await Automator.wait(CONFIG.followVerifyDelay);
      UI.setCountdown('');

      const state = Automator.resolveFollowState(button, username);
      if (!state.success) {
        if (Automator.stopped) {
          UI.log('Follow not confirmed for ' + username + ' (stopped).');
          return 0;
        }
        Automator.triggerRateLimit('button state: "' + (state.text || 'unknown') + '"');
        return 0;
      }

      if (state.text === 'requested') {
        Store.setPendingRequest(username);
        const count = Store.incrementPending();
        UI.updateToday();
        UI.log('REQUEST #' + count + ' (pending) -> ' + username);
        return 1;
      }

      // state.text === 'following'
      Store.setFollow(username);
      const count = Store.incrementFollows();
      UI.updateToday();
      UI.log('FOLLOW #' + count + ' -> ' + username);
      return 1;
    },

    /* ---- perform one unfollow ---- */
    async doUnfollow(button, username, reason) {
      username = norm(username);
      if (!username) return 0;
      Automator.simulateHumanClick(button);
      await Automator.wait(600);

      const confirm = Automator.getButtons(document, ['Unfollow', 'Confirm'])[0];
      if (confirm) Automator.simulateHumanClick(confirm);

      // The click is out; always verify, even if Stop is pressed meanwhile.
      UI.setCountdown('Verifying...');
      await Automator.wait(CONFIG.followVerifyDelay);
      UI.setCountdown('');

      const el = (button && button.isConnected) ? button : Automator.findFollowStateButton(username);
      const text = el ? (el.textContent || '').trim().toLowerCase() : '';
      if (text === 'following' || text === 'requested') {
        // Still followed: the unfollow did not go through. Do not blacklist.
        if (!Automator.stopped) Automator.triggerRateLimit('unfollow did not stick for ' + username);
        return 0;
      }

      // Unfollowed (button is back to "Follow"), or the row is gone and we
      // cannot read it. Either way: blacklist so it is never followed again.
      Store.addBlacklist(username);
      Store.removeHistory(username);
      Store.removePendingRequest(username);
      Store.removeFollowing(username);
      const count = Store.incrementUnfollows();
      UI.updateToday();
      UI.log('UNFOLLOW #' + count + ' (' + reason + (text ? '' : ', unverified') + ') + blacklist -> ' + username);
      return 1;
    },

    /* ---- unfollow eligibility ---- */
    // When this account most recently entered our following: a script follow,
    // a pending request, or the first Following sync that saw it.
    // The script's own record wins; the sync timestamp only covers follows
    // made outside the script (it is later than the real follow time).
    followedAt(username, history, pending, seen) {
      const k = norm(username);
      const own = [history[k], pending[k]].filter(t => typeof t === 'number');
      if (own.length) return Math.max.apply(null, own);
      return seen && typeof seen[k] === 'number' ? seen[k] : null;
    },

    // Returns { ok: true, reason } or { ok: false, why }.
    unfollowVerdict(username, ctx) {
      const k = norm(username);
      if (ctx.whitelist.has(k)) return { ok: false, why: 'PROTECTED (whitelist)' };
      if (ctx.followers.has(k)) return { ok: false, why: 'PROTECTED (follows you)' };
      if (!ctx.following.has(k)) return { ok: false, why: 'SKIP (followed after last Following sync, too new)' };
      const at = Automator.followedAt(k, ctx.history, ctx.pending, ctx.seen);
      if (at !== null && ctx.now - at < ctx.cooldownMs) {
        const hours = Math.floor((ctx.now - at) / 3600000);
        return { ok: false, why: 'SKIP (followed ' + hours + 'h ago, cooldown ' + CONFIG.unfollowCooldownHours + 'h)' };
      }
      return { ok: true, reason: ctx.blacklist.has(k) ? 'blacklist' : 'non-follower' };
    },

    // Fresh Followers list straight from the API, so anyone who followed back
    // since the last manual sync is protected. Returns false if it failed.
    async refreshFollowers() {
      UI.setStatus('Refreshing Followers (protect new follow-backs)...');
      const list = await Automator.scanViaApi('followers', 0);
      if (list === null) return false;
      Store.setMyFollowers(list);
      Store.setLastSync('followers', Date.now());
      Automator.autoBlacklistUnreciprocated();
      UI.updateNetworkCounts();
      UI.updateSyncStatus();
      UI.logDebug('Followers refreshed: ' + list.length + '.');
      return true;
    },

    // People who follow you but you do not follow back: blacklist them so
    // the follow loop never follows them. Needs both lists synced.
    autoBlacklistUnreciprocated() {
      const followers = Store.getMyFollowers();
      const following = Store.getMyFollowing();
      if (!followers.size || !following.size) return 0;
      const pending = Store.getPendingRequests();
      const targets = [];
      for (const u of followers) {
        if (!following.has(u) && !pending[u]) targets.push(u);
      }
      const added = Store.addBlacklistMany(targets);
      if (added > 0) UI.log('Blacklisted ' + added + ' follower' + (added === 1 ? '' : 's') + ' you do not follow back.');
      return added;
    },

    detectFollowerTarget() {
      Automator._lastHeaderRaw = '';
      const dialog = Automator.findDialog();
      if (!dialog) return 0;

      // Determine which modal is open by reading its title.
      // Instagram renders "Followers" or "Following" as the modal header.
      let modalKind = null;
      const headings = dialog.querySelectorAll('h1, h2, h3, [role="heading"]');
      for (const h of headings) {
        const t = (h.innerText || '').trim();
        if (/^followers?\.?$/i.test(t)) { modalKind = 'followers'; break; }
        if (/^following\.?$/i.test(t)) { modalKind = 'following'; break; }
      }
      if (!modalKind) {
        // Fallback: first 80 chars of dialog text.
        const head = (dialog.innerText || '').slice(0, 80);
        if (/^followers?\b/i.test(head)) modalKind = 'followers';
        else if (/^following\b/i.test(head)) modalKind = 'following';
      }
      if (!modalKind) return 0;

      // Find the matching count on the profile page (outside the dialog).
      const pattern = modalKind === 'followers'
        ? /([\d.,]+)\s*(k|m)?\s*followers?/i
        : /([\d.,]+)\s*(k|m)?\s*following/i;
      const candidates = [];
      const all = document.querySelectorAll('a, span, div, h1, h2, h3, p');
      for (const el of all) {
        if (el.closest && el.closest('div[role="dialog"]')) continue;
        if (el.closest && el.closest('#sa-panel')) continue;
        if (el.children.length > 2) continue;
        const t = (el.innerText || '').trim();
        if (!t || t.length > 60) continue;
        const m = t.match(pattern);
        if (!m) continue;
        let n = parseInt(m[1].replace(/[^\d]/g, ''), 10);
        const suf = (m[2] || '').toLowerCase();
        if (suf === 'k') n *= 1000;
        if (suf === 'm') n *= 1000000;
        if (isNaN(n) || n <= 0 || n > 10000000) continue;
        candidates.push({ text: t, n: n });
      }

      // Prefer the shortest candidate (most likely just "187 following").
      candidates.sort((a, b) => a.text.length - b.text.length);
      if (candidates[0]) {
        Automator._lastHeaderRaw = modalKind + ' -> "' + candidates[0].text + '"';
        return candidates[0].n;
      }
      return 0;
    },

    getCookie(name) {
      const parts = ('; ' + document.cookie).split('; ' + name + '=');
      if (parts.length !== 2) return null;
      return parts.pop().split(';').shift();
    },

    apiUrl(kind, userId, maxId) {
      const base = 'https://www.instagram.com/api/v1/friendships/' + userId + '/' + kind + '/?count=' + IG_API.count;
      return maxId ? base + '&max_id=' + encodeURIComponent(maxId) : base;
    },

    async fetchFriendshipPage(kind, maxId) {
      const userId = Automator.getCookie('ds_user_id');
      const csrf = Automator.getCookie('csrftoken');
      if (!userId) throw new Error('NO_USER_ID');
      if (!csrf) throw new Error('NO_CSRF');
      const headers = {
        'X-IG-App-ID': IG_API.appId,
        'X-ASBD-ID': IG_API.asbdId,
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': csrf,
        'Accept': '*/*'
      };
      const resp = await fetch(Automator.apiUrl(kind, userId, maxId), {
        credentials: 'same-origin',
        headers: headers
      });
      if (!resp.ok) {
        throw new Error('HTTP_' + resp.status);
      }
      const json = await resp.json();
      if (!json || (json.status && json.status === 'fail')) {
        throw new Error('API_FAIL: ' + (json && json.message ? json.message : 'unknown'));
      }
      return json;
    },

    async fetchProfileCount(kind) {
      const userId = Automator.getCookie('ds_user_id');
      const csrf = Automator.getCookie('csrftoken');
      if (!userId || !csrf) return 0;
      try {
        const resp = await fetch('https://www.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent('i'), {
          credentials: 'same-origin',
          headers: {
            'X-IG-App-ID': IG_API.appId,
            'X-Requested-With': 'XMLHttpRequest',
            'X-CSRFToken': csrf
          }
        });
        if (!resp.ok) return 0;
        const j = await resp.json();
        const u = j && j.data && j.data.user;
        if (!u) return 0;
        return kind === 'following' ? (u.edge_follow ? u.edge_follow.count : 0) : (u.edge_followed_by ? u.edge_followed_by.count : 0);
      } catch (e) {
        return 0;
      }
    },

    async scanViaApi(kind, expectedTarget) {
      const kindLabel = kind;
      const officialCount = await Automator.fetchProfileCount(kind);
      if (officialCount > 0) {
        UI.logDebug('Profile reports ' + officialCount + ' ' + kindLabel + '.');
      }

      async function doOnePass() {
        const collected = new Set();
        let maxId = null;
        let pageCount = 0;
        let lastProgressLog = 0;
        while (pageCount < IG_API.maxPages && !Automator.stopped) {
          let page;
          try {
            page = await Automator.fetchFriendshipPage(kind, maxId);
          } catch (e) {
            const msg = String(e && e.message || e);
            if (msg === 'NO_USER_ID' || msg === 'NO_CSRF') {
              UI.logDebug('API unavailable (' + msg + '). Falling back to DOM scan.');
              return null;
            }
            UI.log('API error (' + msg + '). Falling back to DOM scan.');
            return null;
          }
          const users = (page && page.users) || [];
          for (const u of users) {
            if (u && u.username) collected.add(String(u.username));
          }
          pageCount++;
          UI.setStatus('API scan: ' + collected.size + ' ' + kindLabel + ' (page ' + pageCount + ')...');
          if (collected.size - lastProgressLog >= 50) {
            UI.log('Scanning via API: ' + collected.size + ' loaded...');
            lastProgressLog = collected.size;
          }
          const nextId = page && page.next_max_id;
          const hasMore = nextId !== null && nextId !== undefined && nextId !== '' && String(nextId) !== '0';
          if (!hasMore) break;
          maxId = page.next_max_id;
          await Automator.sleep(700 + Math.floor(Math.random() * 400), 'API page');
        }
        if (Automator.stopped) return null;
        return Array.from(collected);
      }

      UI.log('Scanning via Instagram API (' + kindLabel + ')...');

      if (expectedTarget > 0) {
        UI.logDebug('DOM target: ' + expectedTarget + ' ' + kindLabel + '.');
      }

      const union = new Set();
      const maxRuns = 4;
      let lastSize = -1;
      let stableRuns = 0;
      const targetForConvergence = expectedTarget && expectedTarget > 0 ? expectedTarget : (officialCount > 0 ? officialCount : 0);

      for (let run = 1; run <= maxRuns && !Automator.stopped; run++) {
        if (run > 1) {
          UI.logDebug('Union pass ' + run + '/' + maxRuns + ' (have ' + union.size + ', target ' + (targetForConvergence || '?') + ')...');
          await Automator.sleep(1200, 'Between passes');
        }

        const onePass = await doOnePass();
        if (onePass === null) {
          if (run === 1) return null;
          break;
        }

        const before = union.size;
        for (const u of onePass) union.add(u);
        const gained = union.size - before;

        // Convergence: two passes in a row with no growth AND we've hit the
        // target OR we have no target to compare against.
        if (gained === 0 && union.size === lastSize) {
          stableRuns++;
          UI.logDebug('Stable run ' + stableRuns + '/2 at ' + union.size + '.');
          if (stableRuns >= 2) {
            UI.logDebug('Converged. Stopping union.');
            break;
          }
        } else {
          stableRuns = 0;
        }
        lastSize = union.size;

        if (targetForConvergence > 0 && union.size >= targetForConvergence) {
          UI.logDebug('Reached target ' + targetForConvergence + '. Stopping union.');
          break;
        }
      }

      if (Automator.stopped) return null;
      return Array.from(union);
    },

    /* ---- scan my own followers (mutual protection list) ---- */
    // kind: 'followers' | 'following', set by the button that was pressed.
    async scanCurrentList(kind) {
      if (Automator.running) {
        UI.log('A loop is running. Press Stop before scanning.');
        return;
      }
      Automator.running = true;
      Automator.stopped = false;
      try {
        await Automator._scanList(kind);
      } finally {
        Automator.running = false;
      }
    },

    async _scanList(kind) {
      const dialog = Automator.findDialog();
      const dialogTitle = dialog ? (dialog.innerText || '').slice(0, 60).toLowerCase() : '';
      const dialogKind = !dialog ? null : (/^following\b/.test(dialogTitle) ? 'following' : 'followers');
      const storeKey = kind || dialogKind;
      if (!storeKey) {
        UI.log('Open the Followers or Following modal first.');
        return;
      }
      const isFollowingModal = storeKey === 'following';

      // The header count is only meaningful when the matching modal is open.
      const expectedTargetCache = dialogKind === storeKey ? Automator.detectFollowerTarget() : 0;

      UI.log('Scanning your ' + storeKey + ' list...');

      // Preferred path: the internal friendships API (paginated, accurate).
      const apiResult = await Automator.scanViaApi(storeKey, expectedTargetCache);
      if (apiResult !== null) {
        if (storeKey === 'following') {
          Store.setMyFollowing(apiResult);
        } else {
          Store.setMyFollowers(apiResult);
        }
        if (storeKey === 'following') {
          const pending = Store.getPendingRequests();
          const followingSet = new Set(apiResult.map(norm));
          let confirmed = 0;
          for (const username in pending) {
            if (followingSet.has(norm(username))) {
              // Request was accepted: promote to confirmed follow. The
              // cooldown starts now, giving them time to follow back.
              Store.setFollow(username);
              delete pending[username];
              confirmed++;
            }
          }
          if (confirmed > 0) {
            writeJSON(KEYS.pending, pending);
            UI.log(confirmed + ' pending request' + (confirmed === 1 ? '' : 's') + ' now confirmed (promoted to follow history).');
          }
          const stillPending = Object.keys(pending).length;
          if (stillPending > 0) {
            UI.logDebug(stillPending + ' request' + (stillPending === 1 ? '' : 's') + ' still pending.');
          }
        }
        Store.setLastSync(storeKey, Date.now());
        Automator.autoBlacklistUnreciprocated();
        const expected = expectedTargetCache || 0;
        if (expected > 0) {
          const diff = expected - apiResult.length;
          if (diff > 0) {
            UI.log('Final (' + storeKey + '): ' + apiResult.length + ' active (profile shows ' + expected + ', ' + diff + ' hidden/deleted by Instagram).');
          } else {
            UI.log('Final (' + storeKey + '): ' + apiResult.length + ' (via API, matches profile).');
          }
        } else {
          UI.log('Final (' + storeKey + '): ' + apiResult.length + ' (via API).');
        }
        UI.setStatus('Scanned ' + apiResult.length + ' ' + storeKey + '.');
        UI.updateToday();
        UI.updateNetworkCounts();
        UI.updateSyncStatus();
        return;
      }

      // Fallback: DOM scraping for edge cases (missing cookies, API failure).
      if (!dialog || dialogKind !== storeKey) {
        UI.setStatus('Open your ' + storeKey + ' modal first.');
        UI.log('API failed. For the DOM fallback, open your ' + storeKey + ' modal and press Sync again.');
        return;
      }
      const scroller = Automator.findScrollContainer(dialog);
      if (!scroller) {
        UI.setStatus('No scroll container found.');
        return;
      }

      const targetCount = Automator.detectFollowerTarget();
      if (targetCount > 0) {
        UI.logDebug('Target: ' + targetCount + ' (raw: "' + (Automator._lastHeaderRaw || '') + '")');
      } else {
        UI.log('No header target found. Using stall-based stopping.');
      }

      const collected = new Set();

      const passes = [
        { label: 'down-fast', step: 200, settle: 400, direction: 'down', resetTo: 'top' },
        { label: 'down-slow', step: 80,  settle: 800, direction: 'down', resetTo: 'top' },
        { label: 'up-slow',   step: 80,  settle: 800, direction: 'up',   resetTo: 'bottom' },
        { label: 'down-final',step: 60,  settle: 900, direction: 'down', resetTo: 'top' }
      ];

      let prevPassSize = -1;

      for (let pi = 0; pi < passes.length && !Automator.stopped; pi++) {
        const cfg = passes[pi];

        // Reset scroll position for this pass.
        if (cfg.resetTo === 'bottom') {
          await Automator.sleep(400, 'Reset');
          scroller.scrollTop = scroller.scrollHeight;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          await Automator.sleep(1200, 'Mounting bottom');
        } else {
          await Automator.resetToTop(scroller, pi === 0 ? 800 : 1200);
        }

        UI.logDebug('Pass ' + (pi + 1) + '/' + passes.length + ' (' + cfg.label + ') start, size=' + collected.size);

        let stall = 0;
        const maxStall = targetCount > 0 ? Math.max(25, Math.ceil(targetCount / 10)) : 30;
        let lastHeight = scroller.scrollHeight;
        let lastTop = scroller.scrollTop;

        while (!Automator.stopped) {
          const before = collected.size;
          const anchors = dialog.querySelectorAll('a[href]');
          for (const a of anchors) {
            const u = usernameFromHref(a.getAttribute('href'));
            if (u) collected.add(u);
          }
          const gained = collected.size - before;
          const height = scroller.scrollHeight;
          const top = scroller.scrollTop;
          const heightGrew = height > lastHeight + 5;

          const atTop = top <= 5;
          const atBottom = top + scroller.clientHeight >= height - 15;
          const atEdge = cfg.direction === 'up' ? atTop : atBottom;

          UI.setStatus('Scanning ' + (pi + 1) + '/' + passes.length + ': ' + collected.size + (targetCount > 0 ? '/' + targetCount : '') + '...');

          if (targetCount > 0 && collected.size >= targetCount) {
            UI.log('Target reached.');
            break;
          }

          if (gained === 0 && !heightGrew && atEdge) {
            stall++;
          } else {
            stall = 0;
          }
          if (stall >= maxStall) {
            UI.logDebug('Pass ' + (pi + 1) + ' stalled at ' + collected.size + '.');
            break;
          }

          lastHeight = Math.max(lastHeight, height);
          lastTop = top;

          if (atEdge) {
            await Automator.jiggleScroll(scroller);
          } else if (cfg.direction === 'up') {
            const step = cfg.step;
            scroller.scrollTop = Math.max(0, top - step);
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            try { scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -step })); } catch (e) {}
            await Automator.sleep(cfg.settle, 'Scan up');
          } else {
            await Automator.microScroll(scroller, cfg.step, cfg.settle);
          }
        }

        if (targetCount > 0 && collected.size >= targetCount) break;
        if (pi > 0 && collected.size === prevPassSize) {
          UI.logDebug('Pass ' + (pi + 1) + ' added no new usernames.');
        }
        prevPassSize = collected.size;
      }

      const list = Array.from(collected);
      if (isFollowingModal) {
        Store.setMyFollowing(list);
      } else {
        Store.setMyFollowers(list);
      }

      if (targetCount > 0) {
        const missing = targetCount - list.length;
        if (missing > 0) {
          UI.log('Final (' + storeKey + '): ' + list.length + '/' + targetCount + ' (' + missing + ' not rendered by platform).');
          UI.setStatus('Scanned ' + list.length + '/' + targetCount + ' ' + storeKey + '.');
        } else {
          UI.log('Final (' + storeKey + '): ' + list.length + '/' + targetCount + ' (complete).');
          UI.setStatus('Scanned ' + list.length + ' ' + storeKey + '.');
        }
      } else {
        UI.log('Final (' + storeKey + '): ' + list.length + ' ' + storeKey + ' (no header target).');
        UI.setStatus('Scanned ' + list.length + ' ' + storeKey + '.');
      }

      Store.setLastSync(storeKey, Date.now());
      Automator.autoBlacklistUnreciprocated();
      UI.updateToday();
    },

    /* ---- loop runner ---- */
    // Holds the running flag until a loop has really finished. Stop only sets
    // `stopped`, so a new run cannot start while the old one is still winding
    // down, and a crash cannot leave `running` stuck on true.
    async runExclusive(fn) {
      if (Automator.running) { UI.log('Already running. Press Stop first.'); return; }
      Automator.running = true;
      Automator.stopped = false;
      UI.setWarning('');
      try {
        await fn();
      } catch (e) {
        Automator.stopped = true;
        UI.setStatus('Stopped (error).');
        UI.log('Error: ' + (e && e.message ? e.message : e) + '. Loop stopped.');
      } finally {
        Automator.running = false;
        UI.setCountdown('');
      }
    },

    /* ---- FOLLOW LOOP ---- */
    startFollowLoop() {
      return Automator.runExclusive(Automator._followLoop);
    },

    async _followLoop() {
      UI.log('Start FOLLOW loop.');

      const dialog = Automator.findDialog();
      if (!dialog) {
        UI.setStatus('Open a list (Following/Followers) in a modal.');
        UI.log('No modal found. Open the list and try again.');
        return;
      }
      const scroller = Automator.findScrollContainer(dialog);

      // Start cleanly at the very top and let the first batch mount.
      await Automator.resetToTop(scroller, 500);

      // Usernames already inspected during this run: stops the virtualized
      // list from re-evaluating (or getting stuck on) remounted rows.
      const processedThisRun = new Set();
      const skippableLabels = SELECTORS.skippableButtonText.map(s => s.toLowerCase());
      // "Follow Back" rows are read too, so they get blacklisted below.
      const readLabels = SELECTORS.followButtonText.concat(['Follow Back']);

      let actionCount = 0;
      let followsThisSession = 0;
      let searchCycles = 0;
      let noNewRounds = 0;

      while (!Automator.stopped) {
        if (Automator.checkBlocked()) break;
        if (Automator.dailyCapReached('follows')) break;

        searchCycles++;
        if (searchCycles % CONFIG.actionsBatchSize === 0) {
          UI.setStatus('Scanning pause (10s)...');
          await Automator.sleep(CONFIG.searchCycleWaitAfterFive, 'Scan');
          if (Automator.stopped) break;
        }

        const myFollowers = Store.getMyFollowers();
        const blacklist = Store.getBlacklist();
        const history = Store.getHistory();
        const pending = Store.getPendingRequests();

        // ---- Step A: read all currently mounted buttons in the container ----
        const buttons = Automator.getButtons(scroller, readLabels);
        const targets = [];
        for (const btn of buttons) {
          if (Automator.stopped) break;

          const label = (btn.textContent || '').trim().toLowerCase();
          const username = norm(Automator.usernameFor(btn));
          if (!username) continue;               // Row not hydrated yet: retry next pass.

          if (processedThisRun.has(username)) continue;

          // Someone who already follows us: protect + blacklist, never revisit.
          if (label === 'follow back' || myFollowers.has(username)) {
            UI.log('SKIP + blacklist (follows you): ' + username);
            Store.addBlacklist(username);
            processedThisRun.add(username);
            continue;
          }
          if (skippableLabels.indexOf(label) !== -1) {
            processedThisRun.add(username);
            continue;
          }
          if (blacklist.has(username)) {
            UI.log('SKIP blacklist: ' + username);
            processedThisRun.add(username);
            continue;
          }
          if (history[username] || pending[username]) {
            UI.log('SKIP already followed: ' + username);
            processedThisRun.add(username);
            continue;
          }

          targets.push({ btn, username });
        }

        // ---- Step B: process every eligible user in the current view ----
        if (targets.length) {
          for (const target of targets) {
            if (Automator.stopped || Automator.dailyCapReached('follows')) break;
            if (Automator.checkBlocked()) break;

            processedThisRun.add(target.username);
            UI.setStatus('Follow: ' + target.username);
            const did = await Automator.doFollow(target.btn, target.username);
            if (Automator.stopped) break;
            if (did) {
              actionCount++;
              followsThisSession++;
              if (Automator.sessionTargetReached(followsThisSession)) break;

              const wait = Automator.randomDelay();
              UI.setStatus('Waiting ' + Math.round(wait / 1000) + 's (jitter)...');
              await Automator.sleep(wait, 'Delay');
              if (Automator.stopped) break;
              await Automator.batchPause(actionCount);
            }
          }
          noNewRounds = 0;
          await Automator.sleep(CONFIG.searchCycleDelay, 'Cycle');
          continue; // Re-scan the same view before scrolling.
        }

        // ---- Step C: nothing eligible here -> ONE micro-scroll of 200px ----
        noNewRounds++;
        UI.setStatus('Scrolling to load more users...');
        const moved = await Automator.microScroll(scroller, 200, 350);
        if (Automator.stopped) break;
        await Automator.sleep(CONFIG.searchCycleDelay, 'Reload');
        await Automator.sleep(1500, 'Waiting for network');
        if (!moved && noNewRounds > 15) {
          UI.setStatus('End of list / no more users loading.');
          UI.log('No new users found. Stopping.');
          break;
        }
      }

      if (!Automator.stopped) UI.setStatus('Follow loop finished.');
    },

    /* ---- UNFOLLOW LOOP (non-followers, older than the cooldown) ---- */
    startUnfollowLoop() {
      return Automator.runExclusive(Automator._unfollowLoop);
    },

    unfollowContext() {
      return {
        followers: Store.getMyFollowers(),
        following: Store.getMyFollowing(),
        blacklist: Store.getBlacklist(),
        whitelist: Store.getWhitelist(),
        history: Store.getHistory(),
        pending: Store.getPendingRequests(),
        seen: Store.getFollowingSeen(),
        cooldownMs: CONFIG.unfollowCooldownHours * 3600 * 1000,
        now: Date.now()
      };
    },

    // Everyone in the synced Following list that may be unfollowed right now.
    eligibleTargets(ctx) {
      const out = new Set();
      for (const u of ctx.following) {
        if (Automator.unfollowVerdict(u, ctx).ok) out.add(u);
      }
      return out;
    },

    remainingTargets(processed) {
      const left = [];
      for (const u of Automator.eligibleTargets(Automator.unfollowContext())) {
        if (!processed.has(u)) left.push(u);
      }
      return left;
    },

    // One guarded unfollow, shared by the scroll pass and the search pass.
    // Returns false when the run must end (stop, cap, block, refresh failure).
    async unfollowOne(btn, username, state) {
      if (Automator.stopped || Automator.dailyCapReached('unfollows')) return false;
      if (Automator.checkBlocked()) return false;

      // Re-check right before the click: the Followers list may have been
      // refreshed during the last batch pause.
      const verdict = Automator.unfollowVerdict(username, Automator.unfollowContext());
      state.processed.add(username);
      if (!verdict.ok) {
        UI.log(verdict.why + ': ' + username);
        return true;
      }

      UI.setStatus('Unfollow (' + verdict.reason + '): ' + username + ' - Stop to abort');
      const did = await Automator.doUnfollow(btn, username, verdict.reason);
      if (Automator.stopped) return false;
      if (!did) return true;

      state.actionCount++;
      const wait = Automator.randomDelay();
      UI.setStatus('Waiting ' + Math.round(wait / 1000) + 's (jitter)...');
      await Automator.sleep(wait, 'Delay');
      if (Automator.stopped) return false;
      if (state.actionCount % CONFIG.actionsBatchSize === 0) {
        await Automator.batchPause(state.actionCount);
        if (Automator.stopped) return false;
        // Pick up anyone who followed back during the pause.
        if (!(await Automator.refreshFollowers())) {
          if (!Automator.stopped) {
            UI.log('Followers refresh failed. Stopping to stay safe.');
            Automator.stop();
          }
          return false;
        }
      }
      return true;
    },

    findSearchInput(dialog) {
      if (!dialog) return null;
      return dialog.querySelector('input[placeholder="Search" i], input[aria-label*="search" i], input[type="text"]');
    },

    // React ignores a plain `.value =`; go through the native setter.
    setInputValue(input, value) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },

    findRowButton(scope, username) {
      const buttons = Automator.getButtons(scope, ['Following', 'Requested']);
      for (const btn of buttons) {
        if (norm(Automator.usernameFor(btn)) === username) return btn;
      }
      return null;
    },

    // The virtualized list often stops loading before the end. Every target
    // the scroll pass never reached is looked up by name in the modal search.
    async unfollowViaSearch(state) {
      const remaining = Automator.remainingTargets(state.processed);
      if (!remaining.length) return;

      if (!Automator.findSearchInput(Automator.findDialog())) {
        UI.log('List stopped loading and the modal has no search box. Not reached (' + remaining.length + '): ' + remaining.join(', '));
        return;
      }
      UI.log('List stopped loading with ' + remaining.length + ' left. Looking them up via search.');

      const missed = [];
      for (const username of remaining) {
        if (Automator.stopped) break;
        const input = Automator.findSearchInput(Automator.findDialog());
        if (!input) { UI.log('Search box disappeared. Stopping search pass.'); break; }

        UI.setStatus('Searching: ' + username);
        Automator.setInputValue(input, username);
        await Automator.sleep(2500, 'Search');

        let btn = null;
        for (let i = 0; i < 4 && !btn && !Automator.stopped; i++) {
          btn = Automator.findRowButton(Automator.findDialog(), username);
          if (!btn) await Automator.sleep(1000, 'Search');
        }
        if (Automator.stopped) break;
        if (!btn) {
          state.processed.add(username);
          missed.push(username);
          UI.log('NOT FOUND via search: ' + username);
          continue;
        }
        if (!(await Automator.unfollowOne(btn, username, state))) break;
      }

      const input = Automator.findSearchInput(Automator.findDialog());
      if (input) Automator.setInputValue(input, '');
      if (missed.length) UI.log('Not found in search (' + missed.length + '), re-sync Following and run again: ' + missed.join(', '));
    },

    async _unfollowLoop() {
      UI.log('Start UNFOLLOW loop (non-followers older than ' + CONFIG.unfollowCooldownHours + 'h).');

      if (Store.getMyFollowing().size === 0) {
        UI.setStatus('Sync your Following list first.');
        UI.log('Refusing to run: Following list is empty. Press [Sync Following] first, so follow ages are known.');
        return;
      }

      const dialog = Automator.findDialog();
      if (!dialog) {
        UI.setStatus('Open the Following list in a modal.');
        UI.log('No modal found. Open the list and try again.');
        return;
      }

      // Always start from a fresh Followers list: someone who followed back
      // an hour ago must not be unfollowed because of an old sync.
      if (!(await Automator.refreshFollowers())) {
        if (Automator.stopped) return;
        UI.setStatus('Could not refresh Followers. Unfollow cancelled.');
        UI.log('Refusing to run: Followers refresh via API failed, mutual followers would not be safely protected.');
        return;
      }
      if (Store.getMyFollowers().size === 0) {
        UI.setStatus('Followers list is empty. Unfollow cancelled.');
        UI.log('Refusing to run: Followers list came back empty.');
        return;
      }

      const scroller = Automator.findScrollContainer(dialog);

      // Start cleanly at the very top and let the first batch mount.
      await Automator.resetToTop(scroller, 500);

      // processed: usernames already inspected during this run.
      const state = { processed: new Set(), actionCount: 0 };

      const eligible = Automator.eligibleTargets(Automator.unfollowContext()).size;
      UI.log('Eligible for unfollow (no follow-back, followed >' + CONFIG.unfollowCooldownHours + 'h ago, not whitelisted): ' + eligible);

      let searchCycles = 0;
      let stuckRounds = 0;
      let reachedEnd = false;

      while (!Automator.stopped) {
        if (Automator.checkBlocked()) break;
        if (Automator.dailyCapReached('unfollows')) break;

        // Done when the target list is empty, not when the DOM looks empty.
        if (!Automator.remainingTargets(state.processed).length) break;

        searchCycles++;
        if (searchCycles % CONFIG.actionsBatchSize === 0) {
          UI.setStatus('Scanning pause (10s)...');
          await Automator.sleep(CONFIG.searchCycleWaitAfterFive, 'Scan');
          if (Automator.stopped) break;
        }

        const ctx = Automator.unfollowContext();

        // ---- Step A: read all currently mounted buttons in the container ----
        const buttons = Automator.getButtons(scroller, ['Following', 'Requested']);
        const targets = [];
        for (const btn of buttons) {
          if (Automator.stopped) break;

          const username = norm(Automator.usernameFor(btn));
          if (!username) continue;               // Row not hydrated yet: retry next pass.

          if (state.processed.has(username)) continue;

          const verdict = Automator.unfollowVerdict(username, ctx);
          if (!verdict.ok) {
            UI.log(verdict.why + ': ' + username);
            state.processed.add(username);
            continue;
          }

          targets.push({ btn, username });
        }

        // ---- Step B: process every eligible user in the current view ----
        if (targets.length) {
          let go = true;
          for (const target of targets) {
            go = await Automator.unfollowOne(target.btn, target.username, state);
            if (!go) break;
          }
          if (!go) break;
          stuckRounds = 0;
          await Automator.sleep(CONFIG.searchCycleDelay, 'Cycle');
          continue; // Re-scan the same view before scrolling.
        }

        // ---- Step C: nothing eligible here -> ONE micro-scroll of 200px ----
        UI.setStatus('Scrolling to load more users...');
        const moved = await Automator.microScroll(scroller, 200, 350);
        if (Automator.stopped) break;
        if (moved) {
          stuckRounds = 0;
        } else {
          // At the bottom while the next page loads: nudge the loader.
          stuckRounds++;
          await Automator.jiggleScroll(scroller);
        }
        await Automator.sleep(CONFIG.searchCycleDelay, 'Reload');
        if (stuckRounds >= 10) {
          reachedEnd = true;
          break;
        }
      }

      if (reachedEnd && !Automator.stopped) await Automator.unfollowViaSearch(state);

      if (!Automator.stopped) {
        const left = Automator.remainingTargets(new Set()).length;
        UI.log('Unfollow loop finished: ' + state.actionCount + ' unfollowed this run, ' + left + ' still eligible.');
        UI.setStatus('Unfollow loop finished (' + state.actionCount + ' unfollowed, ' + left + ' left).');
      }
    },

    /* ---- stop ---- */
    // Only raises the flag. The running loop sees it within ~250ms, finishes
    // the action already in flight, and clears `running` itself.
    stop() {
      Automator.stopped = true;
      UI.setCountdown('');
    }
  };

  /* ------------------------------------------------------------------ */
  /* 6. BLACKLIST EXPORT / CLEAR                                         */
  /* ------------------------------------------------------------------ */
  function exportAndClearBlacklist() {
    const arr = Array.from(Store.getBlacklist());
    if (!arr.length) {
      UI.log('Blacklist is empty.');
      return;
    }
    const blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sa_blacklist_' + todayStr() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    UI.log('Blacklist exported (' + arr.length + ' entries).');

    if (confirm('Clear the blacklist in localStorage now (' + arr.length + ' entries)?')) {
      Store.clearBlacklist();
      UI.log('Blacklist cleared.');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 7. INIT & WIRING                                                    */
  /* ------------------------------------------------------------------ */
  function init() {
    UI.build();
    UI.loadSettings();
    Store.getStats(); // Resets stats on a new day.
    UI.updateToday();
    UI.setStatus('Ready. Step 1: sync your lists.');
    const s0 = Store.getStats();
    UI.log(TITLE + ' loaded. Today: ' + s0.follows + ' follows, ' + s0.pending + ' pending, ' + s0.unfollows + ' unfollows.');

    UI.buttons.follow.addEventListener('click', () => Automator.startFollowLoop());
    UI.buttons.unfollow.addEventListener('click', () => Automator.startUnfollowLoop());
    UI.buttons.syncFollowers.addEventListener('click', () => Automator.scanCurrentList('followers'));
    UI.buttons.syncFollowing.addEventListener('click', () => Automator.scanCurrentList('following'));
    UI.buttons.advancedToggle.addEventListener('click', () => {
      const box = UI.advancedBox;
      const open = box.style.display === 'block';
      box.style.display = open ? 'none' : 'block';
      UI.buttons.advancedToggle.textContent = open ? '[\u25be Advanced]' : '[\u25b4 Advanced]';
    });
    UI.buttons.stop.addEventListener('click', () => {
      Automator.stop();
      UI.setStatus('Stopped by user.');
      UI.log('Stop / Pause pressed.');
    });
    UI.buttons.black.addEventListener('click', exportAndClearBlacklist);

    setInterval(() => {
      Store.getStats();
      UI.updateToday();
      if (Automator.running) Automator.checkBlocked();
    }, 5000);

    window.SA_Automator = Automator;
    window.SA_Config = CONFIG;
    window.SA_Store = Store;
    window.SA_UI = UI;
    return Automator;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
