/**
 * Aqua — water reminder sender. Run by GitHub Actions every ~10 minutes (see .github/workflows/reminders.yml).
 * Needs the env var FIREBASE_SERVICE_ACCOUNT = the full JSON of a Firebase service-account key.
 *
 * A push is sent to a user only when ALL of these hold:
 *   • it's inside their waking window in their own time zone (sleep after midnight works)
 *   • they haven't hit today's goal yet
 *   • it's been at least their interval since their last drink AND since the last reminder
 *   • (optional) they're behind pace, if "Only when I'm behind" is on
 */
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
if (!sa.project_id) { console.warn("FIREBASE_SERVICE_ACCOUNT secret is not set yet — skipping this run."); process.exit(0); }
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const logger = console;

const toMin = (s) => { const [h, m] = String(s || "0:0").split(":").map(Number); return h * 60 + m; };

function localNow(tz, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}

/** "½ glass", "2 glasses", "2½ glasses" — rounded to the nearest half glass. */
function glasses(ml, glass) {
  const n = Math.round((ml / glass) * 2) / 2;
  const whole = Math.floor(n), half = n % 1 ? "½" : "";
  return `${whole || (half ? "" : "0")}${half} ${n <= 1 ? "glass" : "glasses"}`;
}

/** Pick a message that fits how the day is going. */
function compose({ ml, goal, pace, glass }) {
  const left = Math.max(0, goal - ml);
  const done = Math.round((ml / glass) * 2) / 2;
  const total = Math.round(goal / glass);
  const G = (v) => glasses(v, glass);
  if (ml === 0) return { title: "First glass of the day 💧", body: `Today's goal is ${total} glasses. Start with one now.` };
  if (ml < pace - glass) return { title: "Running a little dry 🌵", body: `You're ${G(pace - ml)} behind. Drink one now to catch up.` };
  if (left <= glass * 2) return { title: "Almost there ✨", body: `Only ${G(left)} left to hit today's goal.` };
  const lines = [
    { title: "Water break 💧", body: `${done} of ${total} glasses done. Time for the next one.` },
    { title: "Sip o'clock 🕒", body: `Have a glass of water. ${G(left)} to go today.` },
    { title: "Stay fresh 🌊", body: `You're at ${done} of ${total} glasses. Keep it flowing.` },
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

async function run() {
    const nowMs = Date.now();
    const snap = await db.collection("aqua_users").where("remindersOn", "==", true).get();
    let sent = 0;

    const FORCE = process.env.FORCE_TEST === "true";
    await Promise.all(snap.docs.map(async (doc) => {
      const u = doc.data();
      const who = doc.id.slice(0, 6);
      const skip = (why) => logger.info(`user ${who}…: skipped (${why})`);
      const tokens = (u.tokens || []).filter(Boolean);
      if (!tokens.length) return skip("no device registered");

      const tz = u.tz || "UTC";
      let local;
      try { local = localNow(tz); } catch { local = localNow("UTC"); }

      // waking window
      const w = toMin(u.wake || "07:00");
      let e = toMin(u.sleep || "23:00");
      if (e <= w) e += 1440;
      let m = local.min;
      if (m < w && m + 1440 <= e) m += 1440; // after-midnight but still "awake"
      if (!FORCE && (m < w || m >= e - 10)) return skip(`outside waking hours: local ${local.date} ${Math.floor(local.min / 60)}:${String(local.min % 60).padStart(2, "0")} in ${tz}, window ${u.wake}–${u.sleep}`);

      const goal = Number(u.goalMl) || 2500;
      const glass = Number(u.glassMl || u.settings?.glassMl) || 250;
      const isToday = u.today?.date === local.date;
      const ml = isToday ? Number(u.today.ml) || 0 : 0;
      if (!FORCE && ml >= goal) return skip("goal already reached");

      const interval = Math.max(20, Number(u.intervalMin) || 60);
      const lastReminder = u.lastReminderAt?.toMillis ? u.lastReminderAt.toMillis() : 0;
      const lastDrink = isToday ? Number(u.lastDrinkAt) || 0 : 0;
      const since = (t) => (nowMs - t) / 60000;
      if (!FORCE && since(lastReminder) < interval - 2) return skip(`last reminder ${Math.round(since(lastReminder))} min ago, interval ${interval}`);
      if (!FORCE && since(lastDrink) < interval - 2) return skip(`last glass ${Math.round(since(lastDrink))} min ago, interval ${interval}`);

      const pace = goal * Math.min(1, (m - w) / (e - w));
      if (!FORCE && u.behindOnly && ml >= pace - 100) return skip("on pace and 'only when behind' is on");

      const msg = FORCE ? { title: "Test from Aqua 💧", body: "Reminders are working. You'll get these through the day." } : compose({ ml, goal, pace, glass });
      const res = await getMessaging().sendEachForMulticast({
        tokens,
        data: { title: msg.title, body: msg.body, ml: String(ml), goal: String(goal) },
        webpush: { headers: { Urgency: "high", TTL: String(30 * 60) } },
      });

      res.responses.forEach((r, i) => logger.info(`user ${who}…: device ${i + 1} ${r.success ? "sent" : "FAILED " + (r.error?.code || "") + " " + (r.error?.message || "")}`));
      const dead = [];
      res.responses.forEach((r, i) => {
        const code = r.error?.code || "";
        if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token") || code.includes("invalid-argument")) dead.push(tokens[i]);
      });
      const update = { lastReminderAt: FieldValue.serverTimestamp() };
      if (dead.length) update.tokens = FieldValue.arrayRemove(...dead);
      await doc.ref.update(update);
      sent += res.successCount;
    }));

    logger.info(`waterReminders: ${snap.size} users checked, ${sent} pushes sent`);
}

run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
