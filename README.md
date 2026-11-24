# Aqua: water reminder

A light, phone-first web app (PWA) that:

- works out your daily water goal in **glasses** from your weight, height, age, activity and weather
- shows a measuring glass that fills up as you drink, with one mark per glass
- charts your day against an ideal pace, and shows the last 14 days
- sends **push reminders** during your waking hours, in your time zone. It skips a reminder if you drank recently or have already hit your goal.

Everything runs on free tiers. You don't need a billing card.

| Piece | Where it runs |
|---|---|
| The app (`public/`) | GitHub Pages |
| Sign-in (anonymous), data, push | Firebase project `firechat-a4685` (Spark plan); Aqua's data is in the `aqua_users` collection |
| Reminder sender (`reminders/send.js`) | GitHub Actions workflow `.github/workflows/reminders.yml` |
| Timer that starts the sender every 10 min | Google Apps Script project "Aqua reminder timer" (`apps-script/Timer.gs`) |

## One-time setup: the reminder key

The reminder job needs permission to read Aqua's data and send pushes:

1. Open Firebase console → **Project settings → Service accounts** → **Generate new private key**. A `.json` file downloads.
2. In this GitHub repo, go to **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Secret: paste the **entire** contents of the `.json` file
3. Delete the downloaded `.json` file from your computer.

To test: open the **Actions** tab → **Water reminders** → **Run workflow**.

## Install on your phone

- **Android (Chrome):** open the app link, then tap ⋮ → **Install app**. Open Aqua, go to **Settings → Turn on reminders**, and tap Allow.
- **iPhone (iOS 16.4+):** open the link in Safari, then tap **Share → Add to Home Screen**. Open Aqua from the home screen, then turn on reminders in Settings.

## How a reminder is decided
Every 10 minutes, for each user with reminders on, a push is sent only if:
- it's between your wake and sleep times, in your own time zone
- you haven't reached today's goal
- at least your interval has passed since your last glass **and** since the last reminder
- (optional) you're behind pace, if "Only when I'm behind" is on

GitHub's own cron never fired reliably for this repo, so a Google Apps Script time trigger starts the workflow instead. It uses a fine-grained GitHub token (Actions: read & write, this repo only) stored as the script property `GITHUB_TOKEN`. To pause all reminders, open the Apps Script project → Triggers (⏰) and delete the trigger; run `setUpTimer` to turn them back on.

## Goal formula
Weight × 37 ml (under 30), 35 ml (30–55) or 30 ml (over 55), plus extra for activity (0–900 ml) and weather (0–500 ml). The total is rounded and kept between 1.5 and 4.5 L. You can set your own goal in Settings. This is a general guide, not medical advice.

## Run locally
```bash
cd public && python3 -m http.server 8080
```
