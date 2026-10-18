# Viperlume Online server: setup from zero, free (version 0.0.1, by Playvex)

## What is what
* **viperlume-yandex.zip** = the GAME. This is the ONLY file you upload to the Yandex Games Console.
* **viperlume-server.zip** (this folder) = the small ONLINE SERVER where real players meet. It is NOT uploaded to Yandex.
  It runs on a free hosting website (Render). The game connects to it over the internet.

Without the server the game still works: all modes, plus Practice against computer snakes. Only the Online mode with real players needs it.

---------------------------------------------------------------------
## PART 1: put the server files on GitHub (5 minutes)
---------------------------------------------------------------------
1. Go to **github.com** and sign up (free).
2. Top right: **+ > New repository**. Repository name: `viperlume-server`. Choose **Public**. Click **Create repository**.
3. On the next page click **uploading an existing file**. Drag in `server.js`, `package.json` and `README.md` from this folder.
   Click **Commit changes**.

---------------------------------------------------------------------
## PART 2: start the server on Render (free, no credit card)
---------------------------------------------------------------------
1. Go to **render.com** > **Get Started** and sign up (signing in with GitHub is easiest).
2. Dashboard: **New +** > **Web Service**.
3. Pick your `viperlume-server` repository (allow Render to see it when asked).
   Alternative: choose **Public Git Repository** and paste `https://github.com/YOUR-NAME/viperlume-server`.
4. Fill the form:
   * **Name:** `playvex-viperlume`  (this becomes your address; if it is taken, pick another name)
   * **Region:** the one closest to your players
   * **Branch:** `main`
   * **Runtime / Language:** `Node`
   * **Build Command:** leave what Render proposes (normally `npm install`; it is harmless)
   * **Start Command:** `node server.js`
   * **Instance Type:** **Free**
5. Click **Create Web Service** and wait 1 to 3 minutes until it says **Live**.
6. Copy your address from the top of the page, for example `https://playvex-viperlume.onrender.com`.
7. Test it: open `https://playvex-viperlume.onrender.com/health` in your browser. You must see something like `{"ok":true,...}`.
8. Your **game server address** is the same name with `wss://` in front: `wss://playvex-viperlume.onrender.com`

---------------------------------------------------------------------
## PART 3: keep the free server from falling asleep (free)
---------------------------------------------------------------------
Render's free service goes to sleep after about 15 minutes without visitors. The next player would then wait up to a minute
(the game shows "Waking up the game server..." and waits patiently). To avoid that:
1. Go to **cron-job.org** and sign up (free).
2. **Create cronjob.** Title: `viperlume`. URL: `https://playvex-viperlume.onrender.com/health`. Schedule: **every 5 minutes**. Save.

Do not use the free UptimeRobot plan for this: since December 2024 it is limited to non-commercial use, and a game with ads is commercial.
When your game becomes popular, switch the Render instance to a paid plan (a few dollars a month) so it never sleeps.

---------------------------------------------------------------------
## PART 4: tell the game the server address
---------------------------------------------------------------------
Easiest: send the address from step 2.8 to whoever made your game files and ask for the finished zip.

Or do it yourself on a computer:
1. Unzip `viperlume-yandex.zip` into a new folder (Windows: right-click > **Extract All**).
2. Open `config.js` with Notepad. Change the line
       window.VIPERLUME_SERVER = '';
   to
       window.VIPERLUME_SERVER = 'wss://playvex-viperlume.onrender.com';
   and save.
3. Open the folder, select everything INSIDE it (`index.html`, `config.js`, the `audio` folder), right-click > **Send to > Compressed (zipped) folder**.
   Name it `viperlume.zip`. Important: do not zip the folder itself; `index.html` must be directly inside the zip.

---------------------------------------------------------------------
## PART 5: Yandex Games Console
---------------------------------------------------------------------
1. Open **games.yandex.com/console**, log in with your Yandex account and finish the developer registration
   (you must also sign the agreement in the Console before you can submit a game).
2. Top right: **Add app**. The **Draft** tab opens.
3. **General > Archive:** upload your `viperlume.zip` (the GAME zip, never the server zip).
4. Fill in the other Draft fields (name `Viperlume`, category, descriptions, icon, cover, screenshots).
   Also create four leaderboards in the Console with exactly these technical names: `score`, `daily`, `endless`, `online`,
   and turn on cloud saves if the Draft offers it.
5. Open the **CSP** tab (in some Console versions it is under **Settings**) and add your server host:
       playvex-viperlume.onrender.com
   (only the domain: no `wss://`, no port, no slash). Reason to write: *Real-time multiplayer game server (WebSocket) for the Online mode.*
   Click Save. Yandex reviews this request.
6. Test: in the Archive field click **Open draft**. Press **Online > Quick Match**. Open the draft on a second device or browser
   window and press Quick Match there too: both players should appear in the same arena.
7. Click **Submit for moderation** (usually 3 to 5 working days). Moderators will press Online, so make sure the server is Live first.

---------------------------------------------------------------------
## Cloudflare?
---------------------------------------------------------------------
* **Cloudflare Tunnel (free)** works with this server but only exposes a server running on a computer of yours that must stay on
  24/7, and a permanent address needs a domain you pay for. The free temporary address (`trycloudflare.com`) changes every time, so
  it is only good for testing.
* **Cloudflare Workers (free hosting)** needs a different, rewritten server and the free plan allows roughly 35 hours of total play per day.
Render is the simplest free choice.

## Run locally (test)
    node server.js            # listens on :8787 (Node 18+)
    node test.js              # optional end-to-end test (Node 22+)
Open the game from any local web server with `?mp=ws://localhost:8787` added to its address and press Online > Quick Match in two windows.

## Options (environment variables)
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port (Render sets it for you) |
| `ALLOWED_ORIGINS` | empty = allow all | Comma-separated origin suffixes, e.g. `.yandex.net,.yandex.ru,.yandex.com` (blocked origins are logged) |
| `ROUND_MS` | `78000` | Length of the shared grow phase |
| `LOBBY_MS` | `10000` | Public lobby countdown |
| `BOSS_CAP_MS` | `110000` | Max wait for players to finish their boss fight |

## How a round works (short)
One 2000 x 2000 arena; every screen shows a window that follows your snake and fills the screen. Public rooms (Quick Match):
10 s lobby, 78 s round, up to 8 players. Private rooms: 4-letter code, the host starts. A snake at least 1.5x another's size swallows it.
Every 20 s prey is worth more and more of it appears. At 0:00 everyone fights their own Heavy Snake and reports a score; the server
collects the standings. Nothing is stored on disk; there is no chat; nicknames are generated.

## Troubleshooting
* "Cannot reach the game server": open `https://YOUR-ADDRESS/health`. If it answers, check that `config.js` uses `wss://` and that the host is in the Console CSP tab and approved.
* Works in a normal browser tab but not inside Yandex: the CSP entry is missing or not approved yet.
* "Waking up the game server": the free server was asleep; wait up to a minute.
* Players never see each other: they are in different rooms (one used a private code). Use Quick Match on both.
