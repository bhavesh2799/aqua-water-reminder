// Aqua — water reminder PWA
// Works fully offline with localStorage; Firebase (auth + Firestore + FCM) switches on
// automatically once firebase-config.js has real keys.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v, step) => Math.round(v / step) * step;
const fmt = (n) => Math.round(n).toLocaleString("en-IN");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const STORE_KEY = "aqua.v1";
const FB_VERSION = "10.12.2";
const FB_BASE = `https://www.gstatic.com/firebasejs/${FB_VERSION}/`;

// ───────────────────────── time helpers ─────────────────────────
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const minOfDay = (d = new Date()) => d.getHours() * 60 + d.getMinutes();
const hhmm = (min) => { min = ((min % 1440) + 1440) % 1440; return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; };
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Waking window as [start, end] minutes, end may exceed 1440 if sleep is after midnight. */
function windowMins(s = state.settings) {
  const w = toMin(s.wake); let e = toMin(s.sleep);
  if (e <= w) e += 1440;
  return [w, e];
}
/** Minutes-of-day mapped into the waking-window axis. */
function onAxis(min) {
  const [w] = windowMins();
  return min < w - 120 ? min + 1440 : min; // after-midnight drinks belong to the tail end of the day
}

// ───────────────────────── state ─────────────────────────
const blank = () => ({
  profile: null, // {weightKg, heightCm, age, activity, climate}
  settings: { wake: "07:00", sleep: "23:00", glassMl: 250, interval: "auto", goalOverride: null, pushEnabled: false, paused: false, behindOnly: false },
  days: {}, // { "2026-11-24": { goal, ml, entries: [{t, ml}] } }
});
let state = load();
function load() {
  try { const s = JSON.parse(localStorage.getItem(STORE_KEY)); if (s) return { ...blank(), ...s, settings: { ...blank().settings, ...s.settings } }; } catch {}
  return blank();
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
  scheduleSync();
}
function today() {
  const k = dayKey();
  if (!state.days[k]) state.days[k] = { goal: goalMl(), ml: 0, entries: [] };
  state.days[k].goal = goalMl();
  return state.days[k];
}

// ───────────────────────── hydration maths ─────────────────────────
const ACT = { sedentary: 0, light: 300, moderate: 600, active: 900 };
const CLIM = { cool: 0, mild: 150, hot: 500 };
const ACT_LABEL = { sedentary: "Mostly sitting", light: "Light activity", moderate: "Moderate activity", active: "Very active" };
const CLIM_LABEL = { cool: "Cool weather", mild: "Mild weather", hot: "Hot / humid weather" };

function computeGoal(p) {
  const perKg = p.age < 30 ? 37 : p.age <= 55 ? 35 : 30;
  const base = p.weightKg * perKg;
  const act = ACT[p.activity] ?? 0;
  const clim = CLIM[p.climate] ?? 0;
  const total = clamp(round(base + act + clim, 50), 1500, 4500);
  const bmi = p.heightCm ? p.weightKg / (p.heightCm / 100) ** 2 : null;
  return { perKg, base, act, clim, total, bmi };
}
function goalMl() {
  if (state.settings.goalOverride) return state.settings.goalOverride;
  return state.profile ? computeGoal(state.profile).total : 2500;
}
function autoInterval() {
  const [w, e] = windowMins();
  const glasses = Math.max(1, Math.ceil(goalMl() / state.settings.glassMl));
  return clamp(round((e - w) / glasses, 5), 30, 120);
}
const intervalMin = () => (state.settings.interval === "auto" ? autoInterval() : Number(state.settings.interval));

// ───────────────────────── glasses & bottles (people don't think in ml) ─────────────────────────
const BOTTLE_ML = 500;
const FRAC = { 0: "", 0.5: "½" };
/** "½ glass", "1 glass", "2½ glasses" (rounded to the nearest half glass) */
function glassesStr(ml, glass = state.settings.glassMl) {
  const n = Math.round((ml / glass) * 2) / 2;
  const whole = Math.floor(n), half = n - whole;
  const txt = (whole ? whole : "") + (FRAC[half] || "") || "0";
  return `${txt} ${n > 0 && n <= 1 ? "glass" : "glasses"}`;
}
const glassesNum = (ml) => { const n = Math.round((ml / state.settings.glassMl) * 2) / 2; return (Math.floor(n) || (n % 1 ? "" : "0")) + (n % 1 ? "½" : ""); };
function amountLabel(ml) {
  const g = state.settings.glassMl;
  if (ml === BOTTLE_ML && g !== BOTTLE_ML) return "a bottle";
  if (ml === 1000) return "a 1 L bottle";
  return glassesStr(ml);
}
const ftInToCm = (ft, inch) => Math.round(((ft || 0) * 12 + (inch || 0)) * 2.54);
const cmToFtIn = (cm) => { const t = Math.round(cm / 2.54); return [Math.floor(t / 12), t % 12]; };

// ───────────────────────── navigation ─────────────────────────
function show(view) {
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  $("#tabs").hidden = view === "onboard";
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  if (view === "today") renderToday(true);
  if (view === "history") renderHistory();
  if (view === "settings") renderSettings();
  window.scrollTo({ top: 0 });
}
$$("#tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms);
}

// ───────────────────────── onboarding ─────────────────────────
const form = $("#vitals-form");
const chipVal = {};
$$(".chips", form).forEach((group) => {
  group.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$("button", group).forEach((x) => x.classList.toggle("on", x === b));
    chipVal[group.dataset.name] = b.dataset.v;
    previewGoal();
  });
});
form.addEventListener("input", previewGoal);

function readForm() {
  const f = new FormData(form);
  return {
    weightKg: parseFloat(f.get("weightKg")), heightCm: ftInToCm(parseFloat(f.get("heightFt")), parseFloat(f.get("heightIn"))) || null, age: parseInt(f.get("age"), 10),
    activity: chipVal.activity || "light", climate: chipVal.climate || "mild",
    wake: f.get("wake") || "07:00", sleep: f.get("sleep") || "23:00", glassMl: Number(f.get("glassMl")) || 250,
  };
}
function previewGoal() {
  const v = readForm(); const box = $("#goal-preview");
  if (!(v.weightKg > 20) || !(v.age > 5)) { box.innerHTML = `<span class="hint">Add your weight and age to see your daily goal.</span>`; return; }
  const g = computeGoal(v);
  box.innerHTML = `<div class="big">${Math.round(g.total / v.glassMl)} glasses<small>a day</small></div>
    <div class="sub">${(g.total / 1000).toFixed(1)} litres, or about ${Math.round(g.total / BOTTLE_ML)} half-litre bottles.${g.bmi ? ` BMI ${g.bmi.toFixed(1)}.` : ""}</div>`;
}
function fillForm() {
  const p = state.profile || {}; const s = state.settings;
  form.weightKg.value = p.weightKg ?? 90; const [ft, inch] = p.heightCm ? cmToFtIn(p.heightCm) : [5, 7]; form.heightFt.value = ft; form.heightIn.value = inch; form.age.value = p.age ?? "";
  form.wake.value = s.wake; form.sleep.value = s.sleep; form.glassMl.value = String(s.glassMl);
  chipVal.activity = p.activity || "light"; chipVal.climate = p.climate || "mild";
  $$(".chips", form).forEach((g) => $$("button", g).forEach((b) => b.classList.toggle("on", b.dataset.v === chipVal[g.dataset.name])));
  $("#vitals-submit").textContent = state.profile ? "Save changes" : "Start tracking";
  previewGoal();
}
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = readForm();
  state.profile = { weightKg: v.weightKg, heightCm: v.heightCm, age: v.age, activity: v.activity, climate: v.climate };
  Object.assign(state.settings, { wake: v.wake, sleep: v.sleep, glassMl: v.glassMl });
  today(); save();
  show("today");
  toast(`Your goal is ${Math.round(goalMl() / state.settings.glassMl)} glasses a day`);
});

// ───────────────────────── the water orb ─────────────────────────
class Orb {
  // A measuring glass: tapered tumbler, one graduation mark per glass, water that sloshes.
  constructor(canvas) {
    this.c = canvas; this.ctx = canvas.getContext("2d");
    this.level = 0; this.target = 0; this.vel = 0; this.slosh = 0.6; this.t = 0; this.marks = 15;
    this.bubbles = []; this.drops = []; this.splash = []; this.sparkles = [];
    this.readColors(); this.resize();
    addEventListener("resize", () => this.resize());
    this.tick = this.tick.bind(this); requestAnimationFrame(this.tick);
  }
  readColors() {
    const cs = getComputedStyle(document.documentElement); const g = (n) => cs.getPropertyValue(n).trim();
    this.col = { a: g("--lagoon"), b: g("--deep"), deep: g("--abyss"), mist: g("--mist"), ink: g("--ink"), ink3: g("--ink-3"), paper: g("--paper") };
  }
  resize() {
    const r = this.c.getBoundingClientRect(); if (!r.width) return;
    this.dpr = Math.min(devicePixelRatio || 1, 2.5);
    this.c.width = r.width * this.dpr; this.c.height = r.height * this.dpr;
    this.W = r.width; this.H = r.height;
    // tumbler geometry
    const W = this.W, H = this.H;
    this.top = 14; this.bot = H - 18; this.tw = W - 8; this.bw = W * 0.72; this.wall = 5; this.base = 12;
  }
  setMarks(n) { this.marks = clamp(Math.round(n), 4, 30); }
  set(frac, instant = false) { this.target = clamp(frac, 0, 1); if (instant) this.level = this.target; }
  pour(frac, ml) {
    const n = clamp(Math.round(ml / 120), 1, 5);
    for (let i = 0; i < n; i++)
      this.drops.push({ x: this.W / 2 + (Math.random() - 0.5) * this.W * 0.25, y: this.top + 4 - i * 26, vy: 2 + Math.random(), r: 5 + Math.random() * 3, last: i === n - 1, frac });
  }
  celebrate() {
    for (let i = 0; i < 60; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2, s = 3 + Math.random() * 5;
      this.sparkles.push({ x: this.W / 2, y: this.top + 20, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, r: 1.5 + Math.random() * 2.5 });
    }
    this.slosh = 2;
  }
  // x-extent of the glass interior at a given y
  halfAt(y, inset = 0) {
    const k = (y - this.top) / (this.bot - this.top);
    return (this.tw + (this.bw - this.tw) * k) / 2 - inset;
  }
  glassPath(ctx, inset = 0, bottomInset = 0) {
    const cx = this.W / 2, t = this.top + (inset ? 0 : 0), b = this.bot - bottomInset, r = 16 - inset;
    const ht = this.halfAt(t, inset), hb = this.halfAt(b, inset);
    ctx.beginPath();
    ctx.moveTo(cx - ht, t);
    ctx.lineTo(cx - hb, b - r);
    ctx.quadraticCurveTo(cx - hb + 1, b, cx - hb + r, b);
    ctx.lineTo(cx + hb - r, b);
    ctx.quadraticCurveTo(cx + hb - 1, b, cx + hb, b - r);
    ctx.lineTo(cx + ht, t);
  }
  surfaceY() { const t = this.top + 6, b = this.bot - this.base; return b - this.level * (b - t); }
  tick(ts) {
    requestAnimationFrame(this.tick);
    if (document.hidden || !this.W) return;
    const dt = Math.min(0.05, (ts - (this.last || ts)) / 1000); this.last = ts; this.t += dt;
    this.vel += (this.target - this.level) * 0.035; this.vel *= 0.86; this.level += this.vel;
    this.slosh = Math.max(0.1, this.slosh * 0.985);

    const { ctx, W, H, col } = this; const cx = W / 2;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // soft floor shadow
    const sh = ctx.createRadialGradient(cx, this.bot + 6, 2, cx, this.bot + 6, this.bw * 0.6);
    sh.addColorStop(0, "rgba(15,48,71,.16)"); sh.addColorStop(1, "rgba(15,48,71,0)");
    ctx.fillStyle = sh; ctx.fillRect(0, this.bot - 6, W, 24);

    // glass body (empty part reads as clear glass on paper)
    this.glassPath(ctx); ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,.75)"; ctx.fill();

    // interior clip
    ctx.save();
    this.glassPath(ctx, this.wall, this.base); ctx.closePath(); ctx.clip();

    const surf = this.surfaceY(), R = W / 2;
    const amp = (reduceMotion ? 1.5 : 3) + this.slosh * 6 * (this.level > 0.01 ? 1 : 0);
    const tilt = Math.sin(this.t * 2.4) * this.slosh * 7;
    const wy = (x, k, sp, ph, a) => surf + Math.sin(x * k + this.t * sp + ph) * a + Math.sin(x * k * 2.3 - this.t * sp * 0.7) * a * 0.35 + ((x - cx) / R) * tilt;

    if (this.level > 0.002) {
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 3) ctx.lineTo(x, wy(x, 0.05, 1.6, 2, amp * 0.9) - 3);
      ctx.lineTo(W, H); ctx.closePath(); ctx.globalAlpha = 0.35; ctx.fillStyle = col.a; ctx.fill(); ctx.globalAlpha = 1;

      const g = ctx.createLinearGradient(0, surf - amp, 0, this.bot);
      g.addColorStop(0, "#5CD6EE"); g.addColorStop(0.25, col.a); g.addColorStop(1, col.b);
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 3) ctx.lineTo(x, wy(x, 0.04, -2.1, 0, amp));
      ctx.lineTo(W, H); ctx.closePath(); ctx.fillStyle = g; ctx.fill();

      ctx.beginPath();
      for (let x = 0; x <= W; x += 3) { const y = wy(x, 0.04, -2.1, 0, amp) + 2; x ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.strokeStyle = "rgba(255,255,255,.6)"; ctx.lineWidth = 1.5; ctx.stroke();

      if (!reduceMotion && Math.random() < 0.14 * Math.min(1, this.level * 3)) {
        const by = this.bot - this.base - 2; const hw = this.halfAt(by, this.wall);
        this.bubbles.push({ x: cx + (Math.random() - 0.5) * hw * 1.6, y: by, r: 1 + Math.random() * 2.6, s: 18 + Math.random() * 36, w: Math.random() * 6 });
      }
    }
    ctx.strokeStyle = "rgba(255,255,255,.65)"; ctx.lineWidth = 1.1;
    this.bubbles = this.bubbles.filter((b) => {
      b.y -= b.s * dt; if (b.y < surf + 4) return false;
      ctx.beginPath(); ctx.arc(b.x + Math.sin(this.t * 3 + b.w) * 2, b.y, b.r, 0, Math.PI * 2); ctx.stroke(); return true;
    });

    // graduation marks: one per glass, every 5th longer and numbered
    const t0 = this.top + 6, b0 = this.bot - this.base;
    ctx.font = "600 10px Figtree, system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    for (let i = 1; i <= this.marks; i++) {
      const y = b0 - (i / this.marks) * (b0 - t0);
      const xr = cx + this.halfAt(y, this.wall);
      const major = i % 5 === 0 || i === this.marks;
      const under = y > surf;
      ctx.strokeStyle = under ? "rgba(255,255,255,.75)" : "rgba(15,48,71,.22)";
      ctx.lineWidth = major ? 1.6 : 1.1;
      ctx.beginPath(); ctx.moveTo(xr - 2, y); ctx.lineTo(xr - (major ? 16 : 9), y); ctx.stroke();
      if (major) { ctx.fillStyle = under ? "rgba(255,255,255,.95)" : "rgba(15,48,71,.42)"; ctx.textAlign = "right"; ctx.fillText(String(i), xr - 20, y); }
    }

    // drops + splash
    this.drops = this.drops.filter((d) => {
      d.vy += 900 * dt; d.y += d.vy * dt;
      if (d.y >= surf - 2) {
        for (let i = 0; i < 8; i++) this.splash.push({ x: d.x, y: surf, vx: (Math.random() - 0.5) * 140, vy: -70 - Math.random() * 140, life: 1, r: 1.4 + Math.random() * 1.8 });
        this.slosh = Math.min(2, this.slosh + 0.5);
        if (d.last) this.set(d.frac);
        return false;
      }
      ctx.beginPath();
      ctx.moveTo(d.x, d.y - d.r * 2.2);
      ctx.bezierCurveTo(d.x + d.r * 1.1, d.y - d.r * 0.6, d.x + d.r, d.y + d.r, d.x, d.y + d.r);
      ctx.bezierCurveTo(d.x - d.r, d.y + d.r, d.x - d.r * 1.1, d.y - d.r * 0.6, d.x, d.y - d.r * 2.2);
      ctx.fillStyle = col.a; ctx.fill(); return true;
    });
    this.splash = this.splash.filter((p) => {
      p.vy += 600 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt * 1.7;
      if (p.life <= 0) return false;
      ctx.globalAlpha = p.life; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fillStyle = col.a; ctx.fill(); ctx.globalAlpha = 1; return true;
    });
    ctx.restore();

    // glass walls, thick base, rim, reflections
    this.glassPath(ctx); ctx.closePath();
    ctx.strokeStyle = "rgba(15,48,71,.16)"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.save(); this.glassPath(ctx); ctx.closePath(); ctx.clip();
    ctx.fillStyle = "rgba(220,236,242,.7)"; ctx.fillRect(0, this.bot - this.base, W, this.base + 2);
    const hl = ctx.createLinearGradient(0, 0, W, 0);
    hl.addColorStop(0.08, "rgba(255,255,255,0)"); hl.addColorStop(0.16, "rgba(255,255,255,.55)"); hl.addColorStop(0.24, "rgba(255,255,255,0)");
    ctx.fillStyle = hl; ctx.fillRect(0, this.top, W, this.bot - this.top);
    ctx.restore();
    ctx.beginPath(); ctx.ellipse(cx, this.top, this.tw / 2, 3.5, 0, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(15,48,71,.16)"; ctx.lineWidth = 1.5; ctx.stroke();

    this.sparkles = this.sparkles.filter((s) => {
      s.vy += 0.18; s.x += s.vx; s.y += s.vy; s.life -= dt * 0.9;
      if (s.life <= 0) return false;
      ctx.globalAlpha = s.life; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = Math.random() < 0.5 ? col.a : "#FFB547"; ctx.fill(); ctx.globalAlpha = 1; return true;
    });
  }
}
const orb = new Orb($("#orb"));

// ───────────────────────── today ─────────────────────────
let shownMl = 0;
function countUp(el, from, to, ms = 900) {
  if (reduceMotion) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / ms); const e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

function renderToday(entering = false) {
  const d = today(); const goal = goalMl(); const frac = d.ml / goal;
  const now = new Date(); const h = now.getHours();
  $("#greeting").textContent = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  $("#today-date").textContent = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

  orb.setMarks(goal / state.settings.glassMl);
  if (entering) { orb.set(0, true); orb.slosh = 1.2; requestAnimationFrame(() => orb.set(frac)); countUp($("#amt"), 0, d.ml); countUp($("#pct"), 0, Math.round(frac * 100)); }
  else { countUp($("#amt"), shownMl, d.ml, 700); countUp($("#pct"), Math.round((shownMl / goal) * 100), Math.round(frac * 100), 700); }
  shownMl = d.ml;
  $("#goal").textContent = fmt(goal);
  $("#glasses").textContent = glassesNum(d.ml);
  $("#goal-glasses").textContent = Math.round(goal / state.settings.glassMl);
  const gm = state.settings.glassMl;
  $('.add[data-kind="half"] small').textContent = `${gm / 2} ml`;
  $('.drink small').textContent = `${gm} ml`;

  // status line
  const st = $("#status-line"); st.className = "status";
  const [w, e] = windowMins(); const m = onAxis(minOfDay());
  const pace = goal * clamp((m - w) / (e - w), 0, 1);
  if (d.ml >= goal) { st.textContent = "Goal done for today."; st.classList.add("good"); }
  else if (m < w) st.textContent = "Start your day with a glass.";
  else if (d.ml >= pace - 150) { st.textContent = "You're on track."; st.classList.add("good"); }
  else { st.textContent = `${glassesStr(pace - d.ml)} behind where you should be by now.`; st.classList.add("warn"); }

  const sk = streak(); $("#streak-pill").textContent = sk ? `${sk} day${sk === 1 ? "" : "s"} in a row` : "";
  $("#undo").disabled = !d.entries.length;
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  $("#log").innerHTML = d.entries.slice().reverse().map((x, i) => `<li class="${i === 0 && !entering ? "fresh" : ""}">${cap(amountLabel(x.ml).replace(/^a /, "A "))}<span>${clock(x.t)}</span></li>`).join("");

  const s = state.settings;
  $("#next-reminder").textContent = s.pushEnabled && !s.paused
    ? `Next reminder in about ${intervalMin()} minutes if you don't drink before then.`
    : "Reminders are off. Turn them on in Settings.";
  renderTimeline(d, goal, true);
}

function renderTimeline(d, goal, animate = false) {
  const svg = $("#timeline");
  svg.classList.toggle("anim", animate && !reduceMotion);
  const W = 340, H = 150, L = 34, Rt = 8, T = 10, B = 22;
  const [w, e] = windowMins();
  const maxY = Math.max(goal, d.ml) * 1.08;
  const X = (min) => L + ((clamp(min, w, e) - w) / (e - w)) * (W - L - Rt);
  const Y = (ml) => T + (1 - ml / maxY) * (H - T - B);
  const nowM = onAxis(minOfDay());

  let cum = 0; let path = `M${X(w)},${Y(0)}`;
  for (const en of d.entries.slice().sort((a, b) => a.t - b.t)) {
    const mm = onAxis(minOfDay(new Date(en.t)));
    path += ` L${X(mm)},${Y(cum)}`; cum += en.ml; path += ` L${X(mm)},${Y(cum)}`;
  }
  const endX = X(Math.max(w, Math.min(nowM, e)));
  path += ` L${endX},${Y(cum)}`;
  const area = `${path} L${endX},${Y(0)} Z`;

  const ticks = [w, w + (e - w) / 2, e].map((t) => `<text x="${X(t)}" y="${H - 4}" text-anchor="middle" class="tl-lbl">${hhmm(Math.round(t / 5) * 5)}</text>`).join("");
  const gl = state.settings.glassMl, tot = Math.round(goal / gl);
  const yt = [0, Math.round(tot / 2), tot].map((n) => `<text x="${L - 6}" y="${Y(n * gl) + 3}" text-anchor="end" class="tl-lbl">${n}</text>`).join("");

  svg.innerHTML = `
    <defs>
      <linearGradient id="tlg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--lagoon)" stop-opacity=".55"/><stop offset="1" stop-color="var(--deep)" stop-opacity=".05"/>
      </linearGradient>
      <style>
        .tl-lbl{font:600 10px Figtree,sans-serif;fill:var(--ink-3)}
        .tl-line{fill:none;stroke:var(--deep);stroke-width:2.5;stroke-linejoin:round}
        .anim .tl-line{stroke-dasharray:1;stroke-dashoffset:1;animation:draw 1.4s .1s cubic-bezier(.4,0,.2,1) forwards}
        .anim .tl-area{opacity:0;animation:fade .8s .7s forwards}
        @keyframes draw{to{stroke-dashoffset:0}} @keyframes fade{to{opacity:1}}
        @keyframes pulse{0%{r:4;opacity:1}100%{r:12;opacity:0}}
        .tl-pulse{animation:pulse 1.8s infinite}
      </style>
    </defs>
    <line x1="${L}" x2="${W - Rt}" y1="${Y(goal)}" y2="${Y(goal)}" stroke="var(--mist)" stroke-width="1"/>
    <line x1="${X(w)}" y1="${Y(0)}" x2="${X(e)}" y2="${Y(goal)}" stroke="var(--ink-3)" stroke-width="1.2" stroke-dasharray="4 4" opacity=".55"/>
    <path class="tl-area" d="${area}" fill="url(#tlg)"/>
    <path class="tl-line" d="${path}" pathLength="1"/>
    ${nowM >= w && nowM <= e ? `<line x1="${endX}" x2="${endX}" y1="${T}" y2="${Y(0)}" stroke="var(--ink-3)" stroke-width="1" opacity=".25"/>
      <circle class="tl-pulse" cx="${endX}" cy="${Y(cum)}" r="4" fill="var(--lagoon)"/>
      <circle cx="${endX}" cy="${Y(cum)}" r="4" fill="var(--deep)" stroke="var(--white)" stroke-width="2"/>` : ""}
    ${ticks}${yt}`;
}

function addWater(ml) {
  if (!state.profile) return;
  const d = today(); const goal = goalMl(); const before = d.ml;
  d.entries.push({ t: Date.now(), ml }); d.ml += ml; save();
  orb.pour(d.ml / goal, ml);
  if (navigator.vibrate) navigator.vibrate(15);
  renderToday();
  if (before < goal && d.ml >= goal) setTimeout(() => { orb.celebrate(); toast("That's your goal for today"); }, 650);
}
function undo() {
  const d = today(); const last = d.entries.pop(); if (!last) return;
  d.ml = Math.max(0, d.ml - last.ml); save(); orb.set(d.ml / goalMl()); orb.slosh = 1; renderToday(); toast(`Removed ${amountLabel(last.ml)}`);
}
const KIND_ML = { half: () => state.settings.glassMl / 2, glass: () => state.settings.glassMl, bottle: () => BOTTLE_ML };
$$(".add[data-kind]").forEach((b) => b.addEventListener("click", () => addWater(KIND_ML[b.dataset.kind]())));
$("#undo").addEventListener("click", undo);

const sheet = $("#sheet");
$("#add-custom").addEventListener("click", () => sheet.showModal());
function updateCustom() {
  const n = Number($("#custom-ml").value), ml = n * state.settings.glassMl;
  $("#custom-out").textContent = glassesStr(ml); $("#custom-sub").textContent = `${ml} ml`;
}
$("#custom-ml").addEventListener("input", updateCustom);
$("#add-custom").addEventListener("click", updateCustom);
sheet.addEventListener("close", () => { if (sheet.returnValue === "ok") addWater(Number($("#custom-ml").value) * state.settings.glassMl); });

function streak() {
  let n = 0; const d = new Date();
  const hit = (k) => state.days[k] && state.days[k].ml >= (state.days[k].goal || goalMl());
  if (!hit(dayKey(d))) d.setDate(d.getDate() - 1); // today still in progress
  while (hit(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

// ───────────────────────── history ─────────────────────────
function renderHistory() {
  const days = []; const d = new Date();
  for (let i = 13; i >= 0; i--) { const x = new Date(d); x.setDate(d.getDate() - i); days.push(x); }
  const rows = days.map((x) => ({ x, k: dayKey(x), ...(state.days[dayKey(x)] || { ml: 0, goal: goalMl() }) }));
  const scale = Math.max(goalMl() * 1.25, ...rows.map((r) => r.ml));
  const bars = $("#bars");
  bars.innerHTML = rows.map((r, i) => `
    <div class="bar ${r.ml >= r.goal ? "hit" : ""} ${i === 13 ? "today" : ""}" title="${r.k}: ${fmt(r.ml)} ml">
      <div class="tube"><div class="fill" data-h="${(r.ml / scale) * 100}"></div></div>
      <span class="d">${r.x.getDate()}</span>
    </div>`).join("") + `<div class="goal-line" style="bottom:${24 + (goalMl() / scale) * 216}px"></div>`;
  requestAnimationFrame(() => requestAnimationFrame(() =>
    $$(".fill", bars).forEach((f, i) => { f.style.transitionDelay = `${i * 45}ms`; f.style.height = `${f.dataset.h}%`; })));

  const logged = rows.filter((r) => r.ml > 0);
  $("#st-avg").textContent = logged.length ? glassesNum(logged.reduce((a, r) => a + r.ml, 0) / logged.length) : "–";
  $("#st-avg").nextElementSibling.textContent = "glasses a day";
  $("#st-hit").textContent = `${rows.filter((r) => r.ml >= r.goal && r.ml > 0).length} of 14`;
  $("#st-streak").textContent = streak();
}

// ───────────────────────── settings ─────────────────────────
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const fbConfigured = () => self.FIREBASE_CONFIG && !String(self.FIREBASE_CONFIG.apiKey).startsWith("PASTE");

function renderSettings() {
  const s = state.settings;
  const iv = $("#interval");
  iv.innerHTML = `<option value="auto">${autoInterval()} min (auto)</option>` +
    [30, 45, 60, 90, 120].map((m) => `<option value="${m}">${m < 60 ? m + " min" : m / 60 + (m === 60 ? " hour" : " hours")}</option>`).join("");
  iv.value = String(s.interval);
  $("#glass").value = String(s.glassMl);
  $("#paused").checked = s.paused; $("#behind-only").checked = s.behindOnly;
  $("#tz").textContent = tz.replace("Asia/Calcutta", "India (IST)").replace("Asia/Kolkata", "India (IST)").replace(/_/g, " ");
  $("#goal-override").value = s.goalOverride || "";

  const state_ = $("#push-state"), help = $("#push-help"), btn = $("#enable-push");
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  const on = s.pushEnabled && perm === "granted";
  state_.textContent = on ? (s.paused ? "Paused" : "On") : "Off"; state_.classList.toggle("on", on && !s.paused);
  btn.hidden = on;
  if (!fbConfigured()) help.textContent = "Reminders need the Firebase keys added to firebase-config.js. Tracking already works without them.";
  else if (isIOS && !standalone) help.textContent = "On iPhone: tap Share → Add to Home Screen, then open Aqua from your home screen to enable reminders.";
  else if (perm === "denied") help.textContent = "Notifications are blocked for this site. Allow them in your browser's site settings, then try again.";
  else help.textContent = on ? `You'll get a reminder between ${s.wake} and ${s.sleep} when it's been a while since your last glass.` : "Get a notification on your phone when it's time for a glass.";

  if (state.profile) {
    const g = computeGoal(state.profile);
    const gl2 = s.glassMl;
    $("#goal-breakdown").innerHTML = `
      <div><span>For your weight (${state.profile.weightKg} kg)</span>${glassesStr(g.base, gl2)}</div>
      <div><span>For activity</span>+ ${glassesStr(g.act, gl2)}</div>
      <div><span>For the weather</span>+ ${glassesStr(g.clim, gl2)}</div>
      <div class="total"><span>Daily goal${s.goalOverride ? " (set by you)" : ""}</span>${Math.round(goalMl() / gl2)} glasses</div>`;
  }
}
$("#interval").addEventListener("change", (e) => { state.settings.interval = e.target.value === "auto" ? "auto" : Number(e.target.value); save(); });
$("#glass").addEventListener("change", (e) => { state.settings.glassMl = Number(e.target.value); save(); renderSettings(); });
$("#paused").addEventListener("change", (e) => { state.settings.paused = e.target.checked; save(); renderSettings(); });
$("#behind-only").addEventListener("change", (e) => { state.settings.behindOnly = e.target.checked; save(); });
$("#goal-override").addEventListener("change", (e) => {
  const v = parseInt(e.target.value, 10); state.settings.goalOverride = v >= 800 && v <= 6000 ? round(v, 50) : null; save(); renderSettings();
});
$("#edit-vitals").addEventListener("click", () => { fillForm(); show("onboard"); });
$("#reset").addEventListener("click", () => {
  if (!confirm("Delete all Aqua data on this device?")) return;
  localStorage.removeItem(STORE_KEY); state = blank(); fillForm(); show("onboard");
});
$("#enable-push").addEventListener("click", () => enablePush(false));

// ───────────────────────── Firebase (optional) ─────────────────────────
const FB = {};
async function initFirebase() {
  if (!fbConfigured()) return false;
  try {
    const [appM, authM, fsM] = await Promise.all([
      import(FB_BASE + "firebase-app.js"), import(FB_BASE + "firebase-auth.js"), import(FB_BASE + "firebase-firestore.js"),
    ]);
    FB.app = appM.initializeApp(self.FIREBASE_CONFIG);
    FB.auth = authM.getAuth(FB.app);
    await FB.auth.authStateReady();
    if (!FB.auth.currentUser) await authM.signInAnonymously(FB.auth);
    FB.fs = fsM; FB.db = fsM.getFirestore(FB.app);
    FB.ref = fsM.doc(FB.db, "aqua_users", FB.auth.currentUser.uid);

    // New device / reinstall: pull what the cloud has
    const snap = await fsM.getDoc(FB.ref);
    if (snap.exists() && !state.profile && snap.data().profile) {
      const r = snap.data();
      state.profile = r.profile;
      Object.assign(state.settings, r.settings || {});
      for (const [k, v] of Object.entries(r.history || {})) state.days[k] = { entries: [], ...v };
      if (r.today?.date) state.days[r.today.date] = { goal: r.goalMl, ml: r.today.ml, entries: r.today.entries || [] };
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      boot();
    }
    FB.ready = true; scheduleSync(0);
    if (state.settings.pushEnabled && Notification.permission === "granted") enablePush(true);
    return true;
  } catch (err) { console.warn("[firebase] init failed", err); return false; }
}

let syncTimer;
function scheduleSync(delay = 800) { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, delay); }
async function syncNow() {
  if (!FB.ready || !state.profile) return;
  const d = today(); const s = state.settings;
  const history = {};
  Object.keys(state.days).sort().slice(-30).forEach((k) => (history[k] = { ml: state.days[k].ml, goal: state.days[k].goal }));
  const last = d.entries.length ? d.entries[d.entries.length - 1].t : null;
  try {
    await FB.fs.setDoc(FB.ref, {
      profile: state.profile,
      settings: { wake: s.wake, sleep: s.sleep, glassMl: s.glassMl, interval: s.interval, goalOverride: s.goalOverride, paused: s.paused, behindOnly: s.behindOnly },
      // flat fields the Cloud Function reads
      tz, wake: s.wake, sleep: s.sleep, goalMl: goalMl(), glassMl: s.glassMl, intervalMin: intervalMin(),
      remindersOn: !!s.pushEnabled && !s.paused, behindOnly: !!s.behindOnly,
      today: { date: dayKey(), ml: d.ml, entries: d.entries.slice(-40) },
      lastDrinkAt: last, history, updatedAt: FB.fs.serverTimestamp(),
    }, { merge: true });
  } catch (err) { console.warn("[firebase] sync failed", err); }
}

async function enablePush(silent = false) {
  const fail = (m) => { console.warn("[push]", m); if (!silent) { toast(m, 4200); renderSettings(); const h = $("#push-help"); h.textContent = m; h.style.color = "var(--behind)"; } else renderSettings(); };
  if (!fbConfigured()) return fail("Add your Firebase keys first (firebase-config.js).");
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return fail("This browser doesn't support push notifications.");
  if (isIOS && !standalone) return fail("Add Aqua to your Home Screen first, then enable reminders from there.");
  if (!FB.ready && !(await initFirebase())) return fail("Couldn't reach Firebase. Check your config and connection.");
  const btn = $("#enable-push");
  if (!silent) { btn.disabled = true; btn.textContent = "Turning on…"; }
  const perm = silent ? Notification.permission : await Notification.requestPermission();
  btn.disabled = false; btn.textContent = "Turn on reminders";
  if (perm !== "granted") return fail(perm === "denied" ? "Notifications are blocked for this site. Allow them in your browser's site settings, then tap the button again." : "Notifications weren't allowed. Tap the button again and choose Allow.");
  try {
    const m = await import(FB_BASE + "firebase-messaging.js");
    if (!(await m.isSupported())) return fail("Push isn't supported in this browser.");
    FB.messaging = FB.messaging || m.getMessaging(FB.app);
    const reg = await navigator.serviceWorker.ready;
    const token = await m.getToken(FB.messaging, { vapidKey: self.FIREBASE_VAPID_KEY, serviceWorkerRegistration: reg });
    await FB.fs.setDoc(FB.ref, { tokens: FB.fs.arrayUnion(token) }, { merge: true });
    if (!FB.onMsg) FB.onMsg = m.onMessage(FB.messaging, (p) => toast(p.data?.body || p.notification?.body || "Time for water 💧", 4000));
    state.settings.pushEnabled = true; save(); renderSettings(); if (!$("#view-today").hidden) renderToday();
    if (!silent) toast("Reminders turned on");
  } catch (err) { console.error(err); fail("Couldn't enable push: " + (err.code || err.message)); }
}

// ───────────────────────── boot ─────────────────────────
function boot() {
  if (!state.profile) { fillForm(); show("onboard"); return; }
  show("today");
}
boot();

// Notification action / home-screen shortcut: /?add=250
const addParam = new URLSearchParams(location.search).get("add");
if (addParam && state.profile) {
  history.replaceState(null, "", location.pathname);
  setTimeout(() => addWater(addParam === "glass" ? state.settings.glassMl : clamp(Number(addParam) || state.settings.glassMl, 50, 1000)), 700);
}

// Day rollover & freshness when the app comes back to the foreground
let lastDay = dayKey();
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !state.profile) return;
  if (dayKey() !== lastDay) { lastDay = dayKey(); renderToday(true); } else if (!$("#view-today").hidden) renderToday();
});
setInterval(() => { if (!document.hidden && !$("#view-today").hidden && state.profile) renderTimeline(today(), goalMl()); }, 60_000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./firebase-messaging-sw.js").catch((e) => console.warn("[sw]", e));
}
initFirebase();
