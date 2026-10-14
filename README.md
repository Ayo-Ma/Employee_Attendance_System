# PDN Attendance

Staff clock-in and clock-out for PISHON Digital Network. Everyone uses it from their own phone; a shared front-desk screen is optional.

- **Database:** Firebase Firestore (project `pdn-employee-attendance-system`).
- **Server:** one Vercel function, `api/app.js`. It checks every request, so the rules below cannot be bypassed from the page.
- **Google Sheet:** a live copy of everything, updated within a minute, usually seconds. Make changes in the app, not in the sheet.

## Who can do what

Everyone signs in once per phone with their name and a 4-digit PIN.

| | Staff | Supervisor |
| --- | --- | --- |
| Clock themselves in and out | Yes | Yes |
| See their own week | Yes | Yes |
| See or correct other people's entries | No | Yes |
| Add, edit, remove staff; set or reset PINs | No | Yes |
| Make someone else a supervisor | No | Yes |
| Change the clock-in rules | No | Yes |

**First run:** the first person to open the app sets themselves up as supervisor. Do this yourself before sharing the link.

**Adding staff:** Team › Add staff. The app shows a PIN once; give it to that person. They can change it in Settings. If they forget it: Team › Edit › Reset PIN.

**Another supervisor:** Team › Edit › switch on Supervisor.

**Locked out completely?** In the Firebase console open Firestore › `staff`, and on every document whose `access` is `supervisor`, delete the `pinHash` field. Reload the app; it will offer the first-supervisor setup again.

## Clock-in rules (Settings, supervisors only)

- **Only at the office.** Stand in the office, press "Use where I am now", choose a range, and switch it on. Staff phones must then share their location and be within range to clock in or out.
- **PIN at the front desk.** On a shared screen, tapping a name asks for that person's PIN. Scanning a QR badge does not ask for a PIN.
- **Lock this screen.** On a shared screen in Front desk mode, a supervisor can lock it so only clocking in and out works until their PIN unlocks it.

The time of every phone punch is stamped by the server, not by the phone.

What these do not stop: someone sharing their PIN with a colleague, lending their badge, or faking GPS with a special app.

## Deploying (Vercel)

1. The Vercel project needs one environment variable, **`FIREBASE_SERVICE_ACCOUNT`**: the entire contents of the Firebase service-account key file (Firebase console › Project settings › Service accounts › Generate new private key). Never commit that file.
2. Push to `main`. Vercel serves `index.html`, `css`, `js` and `icons` as they are and runs `api/app.js` as the server function (region `iad1`, next to the database). After changing an environment variable, use **Redeploy**.

To run it on this computer: set `FIREBASE_SERVICE_ACCOUNT_FILE` to the key file's path, run `node server.js`, and open `http://localhost:3000`.

## Connecting the Google Sheet copy

1. In the app: Settings › Google Sheet copy › **Copy sheet script** (supervisors only).
2. In the Google Sheet: **Extensions › Apps Script**, delete everything, paste, save.
3. In the toolbar choose **pullFromApp** and press **Run**. Approve access. Existing tabs are kept, renamed "… (before Firebase)".
4. **Deploy › Manage deployments › Edit › Version: New version › Deploy.** The web app URL must match `sheetUrl` in `js/config.js`; the app pings it after each change so the sheet updates straight away.

The script then checks for changes every minute by itself. Settings shows when the sheet last copied.

## Install it as an app

- **Android (Chrome):** Settings in the app › **Install**, or the browser menu › **Install app**.
- **iPhone (Safari):** Share button › **Add to Home Screen**.

After you deploy a change, phones pick it up the second time the app is opened.

## How it behaves

- Punches from a signed-in phone go straight to the server and need a connection.
- Supervisors' corrections are saved on the device first and upload when the connection allows.
- Open screens check for changes every 30 seconds, and only download what changed.
- Staff can undo their own punch for two minutes.
- A badge left in front of the camera counts once.
- A shift still open after 18 hours is marked **No clock-out** for a supervisor to fix.
- A manual entry whose clock-out is earlier than its clock-in is treated as ending the next day.

## Files

```
index.html, css/, js/, icons/   the app (static files)
sw.js, manifest.webmanifest     makes it installable and quick to open
api/app.js                      the server function
api/_lib/logic.js               the rules: sign-in, PINs, roles, punches, location
api/_lib/firestore.js           talks to Firestore
api/_lib/sheetScript.js         the Google Sheet copy script handed out by the app
js/config.js                    organisation name, server path, sheet ping URL
server.js                       local test server (not deployed)
_backup-original/               the app before the redesign (not in git)
```
