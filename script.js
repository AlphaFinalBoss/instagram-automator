/* =========================================================================
 * Social Automator v2.0
 * -------------------------------------------------------------------------
 * A self-contained, vanilla-JS console / userscript automator for
 * follow / unfollow workflows.
 *
 * No build step, no external dependencies. Paste into the browser console,
 * or load as a userscript. A floating control panel is injected into the
 * page automatically.
 *
 * Features
 *   - Follow loop with human-like click simulation and randomized jitter.
 *   - Shadow rate-limit / silent-rollback detection with audio alert.
 *   - Unfollow loop that only targets non-followers older than 24h and
 *     never touches mutual followers.
 *   - Persistent blacklist, follow history and per-day statistics.
 *   - Configurable session target, daily cap, batch size and batch delay.
 *   - Safe Mode / Fast Mode presets.
 *
 * License: MIT
 * ========================================================================= */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 0. GUARD & META                                                     */
  /* ------------------------------------------------------------------ */
  if (window.SA_Automator) return; // Prevent double injection.

  const VERSION = '2.0';
  const TITLE = 'Social Automator v' + VERSION;

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
    safe: { actionsBatchSize: 6, waitAfterFiveActions: 150000, maxDailyActions: 100 },
    fast: { actionsBatchSize: 10, waitAfterFiveActions: 90000, maxDailyActions: 150 },
    custom: null
  };

  // Persisted defaults for the settings drawer.
  const DEFAULT_SETTINGS = {
    preset: 'safe',
    sessionTarget: 0,
    maxDailyActions: 100,
    actionsBatchSize: 6,
    waitAfterFiveActions: 150000
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

  /* ------------------------------------------------------------------ */
  /* 2. STATE MANAGEMENT (localStorage)                                  */
  /* ------------------------------------------------------------------ */
  const KEYS = {
    blacklist: 'sa_blacklist',
    history: 'sa_follow_history',
    stats: 'sa_daily_stats',
    myFollowers: 'sa_my_followers',
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

  const Store = {
    /* ---- blacklist ---- */
    getBlacklist() {
      const arr = readJSON(KEYS.blacklist, []);
      return new Set(Array.isArray(arr) ? arr : []);
    },
    addBlacklist(username) {
      if (!username) return;
      const set = Store.getBlacklist();
      set.add(username);
      writeJSON(KEYS.blacklist, Array.from(set));
    },
    removeBlacklist(username) {
      const set = Store.getBlacklist();
      set.delete(username);
      writeJSON(KEYS.blacklist, Array.from(set));
    },
    clearBlacklist() {
      writeJSON(KEYS.blacklist, []);
    },

    /* ---- mutual followers (accounts that follow me) ---- */
    getMyFollowers() {
      const arr = readJSON(KEYS.myFollowers, []);
      return new Set(Array.isArray(arr) ? arr : []);
    },
    setMyFollowers(array) {
      const arr = Array.isArray(array) ? array : Array.from(array || []);
      writeJSON(KEYS.myFollowers, arr);
      return arr;
    },

    /* ---- follow history (username -> timestamp) ---- */
    getHistory() {
      const obj = readJSON(KEYS.history, {});
      return obj && typeof obj === 'object' ? obj : {};
    },
    setFollow(username) {
      if (!username) return;
      const h = Store.getHistory();
      h[username] = Date.now();
      writeJSON(KEYS.history, h);
    },
    removeHistory(username) {
      const h = Store.getHistory();
      delete h[username];
      writeJSON(KEYS.history, h);
    },

    /* ---- daily statistics ---- */
    getStats() {
      let stats = readJSON(KEYS.stats, null);
      const today = todayStr();
      if (!stats || stats.date !== today) {
        stats = { date: today, count: 0 };
        writeJSON(KEYS.stats, stats);
      }
      return stats;
    },
    incrementStats() {
      const stats = Store.getStats();
      stats.count += 1;
      writeJSON(KEYS.stats, stats);
      return stats.count;
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
    let followBtn, unfollowBtn, scanBtn, stopBtn, blackBtn, settingsToggle, settingsBox;
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

      /* ---- action buttons ---- */
      const btnWrap = document.createElement('div');
      style(btnWrap, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '8px' });

      followBtn = mkButton('[Start Follow Loop]', '#1f9d55');
      unfollowBtn = mkButton('[Start Unfollow >24h]', '#d97706');
      scanBtn = mkButton('[Scan My Followers]', '#2563eb');
      stopBtn = mkButton('[Stop / Pause]', '#c53030');
      blackBtn = mkButton('[Export / Clear Blacklist]', '#334155');
      settingsToggle = mkButton('[Settings]', '#475569');

      btnWrap.appendChild(followBtn);
      btnWrap.appendChild(unfollowBtn);
      scanBtn.style.gridColumn = '1 / span 2';
      stopBtn.style.gridColumn = '1 / span 2';
      settingsToggle.style.gridColumn = '1 / span 2';
      blackBtn.style.gridColumn = '1 / span 2';
      btnWrap.appendChild(scanBtn);
      btnWrap.appendChild(stopBtn);
      btnWrap.appendChild(settingsToggle);
      btnWrap.appendChild(blackBtn);
      panel.appendChild(btnWrap);

      /* ---- status lines ---- */
      statusLine = document.createElement('div');
      style(statusLine, { marginBottom: '4px', color: '#9fe6b3', minHeight: '15px', lineHeight: '1.35' });
      todayLine = document.createElement('div');
      style(todayLine, { marginBottom: '4px', color: '#8b93a1' });
      countdownLine = document.createElement('div');
      style(countdownLine, { marginBottom: '6px', color: '#ffd166', fontWeight: '600' });
      warningLine = document.createElement('div');
      style(warningLine, {
        marginBottom: '6px', color: '#ff5c5c', fontWeight: '700', display: 'none',
        background: 'rgba(255,92,92,.12)', border: '1px solid rgba(255,92,92,.4)',
        borderRadius: '6px', padding: '6px', lineHeight: '1.35'
      });

      /* ---- manual blacklist ---- */
      const blWrap = document.createElement('div');
      style(blWrap, { display: 'flex', gap: '6px', marginBottom: '6px' });
      const blInput = document.createElement('input');
      blInput.type = 'text';
      blInput.placeholder = 'username without @';
      style(blInput, {
        background: '#0d0f12', padding: '5px', border: '1px solid #334155',
        borderRadius: '6px', color: '#fff', width: '65%', boxSizing: 'border-box', fontSize: '11px'
      });
      const blBtn = document.createElement('button');
      blBtn.textContent = '+ Blacklist';
      style(blBtn, {
        background: '#475569', color: '#fff', border: 'none', padding: '5px',
        borderRadius: '6px', fontWeight: '600', cursor: 'pointer', fontSize: '11px', flex: '1'
      });
      function addManualBlacklist() {
        const value = (blInput.value || '').trim().replace(/@/g, '');
        if (!value) return;
        Store.addBlacklist(value);
        log('Manual blacklist -> ' + value);
        blInput.value = '';
      }
      blBtn.addEventListener('click', addManualBlacklist);
      blInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addManualBlacklist(); }
      });
      blWrap.appendChild(blInput);
      blWrap.appendChild(blBtn);

      /* ---- settings drawer ---- */
      settingsBox = buildSettingsBox();

      /* ---- log box ---- */
      logBox = document.createElement('div');
      style(logBox, {
        maxHeight: '150px', overflowY: 'auto', background: '#0d0f12',
        border: '1px solid #23262d', borderRadius: '8px', padding: '6px',
        lineHeight: '1.4', color: '#c7ccd6', whiteSpace: 'pre-wrap'
      });

      panel.appendChild(statusLine);
      panel.appendChild(todayLine);
      panel.appendChild(countdownLine);
      panel.appendChild(warningLine);
      panel.appendChild(settingsBox);
      panel.appendChild(blWrap);
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
      if (todayLine) todayLine.textContent = 'Today: ' + s.count + ' / ' + CONFIG.maxDailyActions;
    }
    function log(msg) {
      if (!logBox) return;
      const t = new Date().toLocaleTimeString();
      const line = document.createElement('div');
      line.textContent = '[' + t + '] ' + msg;
      logBox.appendChild(line);
      while (logBox.childNodes.length > maxLogs) logBox.removeChild(logBox.firstChild);
      logBox.scrollTop = logBox.scrollHeight;
    }

    return {
      build, loadSettings, applyPreset, setStatus, setCountdown, setWarning, updateToday, log,
      buttons: {
        get follow() { return followBtn; },
        get unfollow() { return unfollowBtn; },
        get scan() { return scanBtn; },
        get stop() { return stopBtn; },
        get black() { return blackBtn; }
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
      const reserved = ['p', 'explore', 'reel', 'stories', 'accounts', 'direct', 'about', 'directory'];
      let node = el;
      let depth = 0;
      while (node && depth < 8) {
        const anchors = node.querySelectorAll ? node.querySelectorAll('a[href]') : [];
        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          const clean = href.replace(/^https?:\/\/[^\/]+/, '');
          const m = clean.match(/^\/([A-Za-z0-9._]+)\/?$/);
          if (m && m[1] && reserved.indexOf(m[1]) === -1) return m[1];
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

    /* ---- raw incremental scroll with jiggle fallback ---- */
    // Advances the list by a fixed pixel amount so the platform's lazy
    // loader keeps fetching rows. When the list bound is reached the
    // scroll position is jiggled to nudge loaders that stall in
    // background tabs.
    async incrementalScroll(scroller) {
      if (!scroller) return false;
      const before = scroller.scrollTop;
      scroller.scrollTop += 550;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 550 }));
      await Automator.sleep(350, 'Scroll');
      if (Automator.stopped) return false;

      if (scroller.scrollTop === before) {
        // Reached the bound: jiggle up then push down again.
        scroller.scrollTop = Math.max(0, before - 120);
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await Automator.sleep(220, 'Jiggle');
        scroller.scrollTop = before + 550;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await Automator.sleep(600, 'Load');
      }
      return scroller.scrollTop !== before;
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
      const text = (document.body.innerText || '').toLowerCase();
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
    dailyCapReached() {
      const s = Store.getStats();
      if (s.count >= CONFIG.maxDailyActions) {
        UI.setStatus('Daily cap reached (' + s.count + '/' + CONFIG.maxDailyActions + '). Stopping.');
        UI.log('Daily cap reached. Stopping.');
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
      const labels = FOLLOW_SUCCESS_LABELS.concat(FOLLOW_FAILURE_LABELS);
      for (const b of buttons) {
        const txt = (b.textContent || '').trim().toLowerCase();
        if (labels.indexOf(txt) === -1) continue;
        if (Automator.usernameFor(b) === username) return b;
      }
      return null;
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
      if (!username) username = 'user_' + Date.now();

      const blacklist = Store.getBlacklist();
      if (blacklist.has(username)) { UI.log('SKIP (blacklist): ' + username); return 0; }
      const history = Store.getHistory();
      if (history[username]) { UI.log('SKIP (already followed): ' + username); return 0; }

      Automator.simulateHumanClick(button);

      // Wait, then verify the button actually transitioned.
      await Automator.sleep(CONFIG.followVerifyDelay, 'Verifying');
      if (Automator.stopped) return 0;

      const state = Automator.resolveFollowState(button, username);
      if (!state.success) {
        Automator.triggerRateLimit('button state: "' + (state.text || 'unknown') + '"');
        return 0;
      }

      Store.setFollow(username);
      const count = Store.incrementStats();
      UI.updateToday();
      UI.log('FOLLOW #' + count + ' -> ' + username);
      return 1;
    },

    /* ---- perform one unfollow ---- */
    async doUnfollow(button, username) {
      if (!username) return 0;
      Automator.simulateHumanClick(button);
      await Automator.sleep(600, 'Confirming');

      const confirm = Automator.getButtons(document, ['Unfollow', 'Confirm'])[0];
      if (confirm) Automator.simulateHumanClick(confirm);

      // Permanently blacklist and forget the follow record.
      Store.addBlacklist(username);
      Store.removeHistory(username);
      const count = Store.incrementStats();
      UI.updateToday();
      UI.log('UNFOLLOW #' + count + ' + blacklist -> ' + username);
      return 1;
    },

    /* ---- scan my own followers (mutual protection list) ---- */
    async scanMyFollowers() {
      if (Automator.running) {
        UI.log('A loop is running. Press Stop before scanning.');
        return;
      }
      const dialog = Automator.findDialog();
      if (!dialog) {
        UI.setStatus('Open your Followers modal first.');
        UI.log('No modal found for scanning.');
        return;
      }
      const scroller = Automator.findScrollContainer(dialog);
      const found = Store.getMyFollowers();
      try { scroller.scrollTop = 0; } catch (e) { /* noop */ }
      UI.log('Scanning your followers list...');
      let noNew = 0;
      while (true) {
        const before = found.size;
        const anchors = scroller.querySelectorAll('a[href]');
        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          const clean = href.replace(/^https?:\/\/[^\/]+/, '');
          const m = clean.match(/^\/([A-Za-z0-9._]+)\/?$/);
          if (m && m[1] && ['p', 'explore', 'reel', 'stories', 'accounts', 'direct', 'about', 'directory'].indexOf(m[1]) === -1) {
            found.add(m[1]);
          }
        }
        if (found.size === before) noNew++; else noNew = 0;
        UI.log('Scanning... ' + found.size + ' followers found.');
        if (noNew > 6) break;
        await Automator.incrementalScroll(scroller);
        await Automator.sleep(800, 'Scan');
      }
      const list = Array.from(found);
      Store.setMyFollowers(list);
      UI.log('Saved ' + list.length + ' mutual followers.');
      UI.setStatus('Scanned ' + list.length + ' mutual followers.');
    },

    /* ---- FOLLOW LOOP ---- */
    async startFollowLoop() {
      if (Automator.running) { UI.log('Already running. Press Stop first.'); return; }
      Automator.running = true;
      Automator.stopped = false;
      UI.setWarning('');
      UI.log('Start FOLLOW loop.');

      const dialog = Automator.findDialog();
      if (!dialog) {
        UI.setStatus('Open a list (Following/Followers) in a modal.');
        UI.log('No modal found. Open the list and try again.');
        Automator.running = false;
        return;
      }
      const scroller = Automator.findScrollContainer(dialog);
      let actionCount = 0;
      let followsThisSession = 0;
      let searchCycles = 0;
      let noNewRounds = 0;

      while (!Automator.stopped) {
        if (Automator.checkBlocked()) break;
        if (Automator.dailyCapReached()) break;

        searchCycles++;
        if (searchCycles % CONFIG.actionsBatchSize === 0) {
          UI.setStatus('Scanning pause (10s)...');
          await Automator.sleep(CONFIG.searchCycleWaitAfterFive, 'Scan');
          if (Automator.stopped) break;
        }

        const buttons = Automator.getButtons(scroller, SELECTORS.followButtonText);
        let actedThisRound = 0;

        for (const btn of buttons) {
          if (Automator.stopped) break;
          if (Automator.dailyCapReached()) break;
          if (Automator.checkBlocked()) break;

          const label = (btn.textContent || '').trim().toLowerCase();
          const username = Automator.usernameFor(btn);

          // Someone who already follows us: protect them and blacklist.
          if (label === 'follow back') {
            if (username) {
              UI.log('SKIP + blacklist (follows you): ' + username);
              Store.addBlacklist(username);
            }
            continue;
          }
          if (SELECTORS.skippableButtonText.map(s => s.toLowerCase()).indexOf(label) !== -1) continue;

          if (!username) { UI.log('Could not extract username, skipping.'); continue; }

          const myFollowers = Store.getMyFollowers();
          if (myFollowers.has(username)) {
            UI.log('SKIP + blacklist (already follows you): ' + username);
            Store.addBlacklist(username);
            continue;
          }

          if (Store.getBlacklist().has(username)) { UI.log('SKIP blacklist: ' + username); continue; }
          if (Store.getHistory()[username]) { UI.log('SKIP already followed: ' + username); continue; }

          UI.setStatus('Follow: ' + username);
          const did = await Automator.doFollow(btn, username);
          if (Automator.stopped) break;
          if (did) {
            actedThisRound++;
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

        if (actedThisRound === 0) {
          noNewRounds++;
          UI.setStatus('Scrolling to load more users...');
          const moved = await Automator.incrementalScroll(scroller);
          await Automator.sleep(CONFIG.searchCycleDelay, 'Reload');
          await Automator.sleep(1500, 'Waiting for network');
          if (!moved && noNewRounds > 15) {
            UI.setStatus('End of list / no more users loading.');
            UI.log('No new users found. Stopping.');
            break;
          }
        } else {
          noNewRounds = 0;
          await Automator.sleep(CONFIG.searchCycleDelay, 'Cycle');
        }
      }

      Automator.running = false;
      if (!Automator.stopped) UI.setStatus('Follow loop finished.');
      UI.setCountdown('');
    },

    /* ---- UNFOLLOW LOOP (>24h, non-followers only) ---- */
    async startUnfollowLoop() {
      if (Automator.running) { UI.log('Already running. Press Stop first.'); return; }
      Automator.running = true;
      Automator.stopped = false;
      UI.setWarning('');
      UI.log('Start UNFOLLOW loop (>24h).');

      const dialog = Automator.findDialog();
      if (!dialog) {
        UI.setStatus('Open the Following list in a modal.');
        UI.log('No modal found. Open the list and try again.');
        Automator.running = false;
        return;
      }
      const scroller = Automator.findScrollContainer(dialog);
      const cooldownMs = CONFIG.unfollowCooldownHours * 3600 * 1000;
      const history = Store.getHistory();

      let eligible = 0;
      for (const u in history) {
        if (Date.now() - history[u] > cooldownMs) eligible++;
      }
      UI.log('Accounts eligible for unfollow (>' + CONFIG.unfollowCooldownHours + 'h): ' + eligible);

      let actionCount = 0;
      let searchCycles = 0;
      let noNewRounds = 0;

      while (!Automator.stopped) {
        if (Automator.checkBlocked()) break;
        if (Automator.dailyCapReached()) break;

        searchCycles++;
        if (searchCycles % CONFIG.actionsBatchSize === 0) {
          UI.setStatus('Scanning pause (10s)...');
          await Automator.sleep(CONFIG.searchCycleWaitAfterFive, 'Scan');
          if (Automator.stopped) break;
        }

        const buttons = Automator.getButtons(scroller, ['Following', 'Requested']);
        let actedThisRound = 0;
        const curHistory = Store.getHistory();

        for (const btn of buttons) {
          if (Automator.stopped) break;
          if (Automator.dailyCapReached()) break;
          if (Automator.checkBlocked()) break;

          const username = Automator.usernameFor(btn);
          if (!username) continue;

          // Never unfollow a mutual follower.
          const myFollowers = Store.getMyFollowers();
          if (myFollowers.has(username)) {
            UI.log('PROTECTED (mutual follow): ' + username);
            continue;
          }

          const ts = curHistory[username];
          if (ts && Date.now() - ts <= cooldownMs) {
            UI.log('SKIP (under 24h): ' + username);
            continue;
          }
          if (!ts) {
            UI.log('SKIP (not in history): ' + username);
            continue;
          }

          UI.setStatus('Unfollow: ' + username);
          await Automator.doUnfollow(btn, username);
          actedThisRound++;
          actionCount++;

          const wait = Automator.randomDelay();
          UI.setStatus('Waiting ' + Math.round(wait / 1000) + 's (jitter)...');
          await Automator.sleep(wait, 'Delay');
          if (Automator.stopped) break;
          await Automator.batchPause(actionCount);
        }

        if (actedThisRound === 0) {
          noNewRounds++;
          UI.setStatus('Scrolling to load more users...');
          const moved = await Automator.incrementalScroll(scroller);
          await Automator.sleep(CONFIG.searchCycleDelay, 'Reload');
          if (!moved && noNewRounds > 12) {
            UI.setStatus('End of list. Unfollow loop finished.');
            UI.log('No more accounts to unfollow. Stopping.');
            break;
          }
        } else {
          noNewRounds = 0;
          await Automator.sleep(CONFIG.searchCycleDelay, 'Cycle');
        }
      }

      Automator.running = false;
      if (!Automator.stopped) UI.setStatus('Unfollow loop finished.');
      UI.setCountdown('');
    },

    /* ---- stop ---- */
    stop() {
      Automator.stopped = true;
      Automator.running = false;
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
    UI.setStatus('Ready. Open a list and press Start.');
    UI.log(TITLE + ' loaded. Today: ' + Store.getStats().count + '.');

    UI.buttons.follow.addEventListener('click', () => Automator.startFollowLoop());
    UI.buttons.unfollow.addEventListener('click', () => Automator.startUnfollowLoop());
    UI.buttons.scan.addEventListener('click', () => Automator.scanMyFollowers());
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
