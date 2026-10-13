# PDN Attendance

Staff clock-in and clock-out for PISHON Digital Network. Everyone uses it from their own phone; a shared front-desk screen is optional. One Google Sheet is the database.

## Who can do what

Everyone signs in once per phone with their name and a 4-digit PIN. The Google Sheet checks every request, so these rules cannot be bypassed from the page.

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

**Locked out completely?** Open the Staff tab of the sheet, delete the cell in the "PIN (hidden)" column for every supervisor, and reload the app. It will offer the first-supervisor setup again.

## Clock-in rules (Settings, supervisors only)

- **Only at the office.** Stand in the office, press "Use where I am now", choose a range, and switch it on. Staff phones must then share their location and be within range to clock in or out.
- **PIN at the front desk.** On a shared screen, tapping a name asks for that person's PIN. Scanning a QR badge does not ask for a PIN.
- **Lock this screen.** On a shared screen in Front desk mode, a supervisor can lock it so only clocking in and out works until their PIN unlocks it.

The time of every phone punch is stamped by the sheet, not by the phone.

What these do not stop: someone sharing their PIN with a colleague, lending their badge, or faking GPS with a special app.

## Connect the Google Sheet (once)

1. Open your Google Sheet and choose **Extensions › Apps Script**.
2. In the app press **Copy script** (on the sign-in screen if the sheet is out of date, otherwise in Settings). Delete the code in Apps Script, paste, and save.
3. First time: **Deploy › New deployment**, type **Web app**, **Execute as: Me**, **Who has access: Anyone**.
   Updating an existing one: **Deploy › Manage deployments › Edit › Version: New version**. The URL stays the same.
4. The **Web app URL** ends in `/exec`. It goes in `js/config.js` as `sheetsUrl`, so every device uses it without any setup.

The script keeps three tabs: **Attendance**, **Staff** and **Settings**. Edit entries in the app rather than typing in those tabs.

## Deploy

Upload `index.html`, the `css` folder and the `js` folder to any static host that serves HTTPS. HTTPS is required for location and for the camera.

To try it on this computer: `node server.js`, then open `http://localhost:3000`.

## Install it as an app

Open the site on the phone, then:

- **Android (Chrome):** Settings in the app › **Install**, or the browser menu › **Install app**.
- **iPhone (Safari):** Share button › **Add to Home Screen**.

It then has its own icon, opens full screen, and loads from the phone instead of the network. After you deploy a change, phones pick it up the second time the app is opened.

## How it behaves

- A punch from a signed-in phone goes straight to the sheet and needs a connection.
- Supervisors' corrections are saved on the device first and upload when the connection allows.
- Open screens check the sheet every 60 seconds.
- Staff can undo their own punch for two minutes.
- A badge left in front of the camera counts once.
- A shift still open after 18 hours is marked **No clock-out** for a supervisor to fix.
- A manual entry whose clock-out is earlier than its clock-in is treated as ending the next day.

## Files

```
index.html            page structure
css/style.css         design
css/print.css         printed register and badges
js/config.js          organisation name and the Google Sheet URL
js/app.js             screens and interactions
js/clockEngine.js     punch rules for supervisor devices
js/storage.js         on-device data
js/sheetsSync.js      sign-in and all traffic with the sheet
js/appsScript.js      the script that goes into the Google Sheet (where the rules are enforced)
js/qrScanner.js       camera scanning (jsQR in js/vendor as the fallback decoder)
js/badges.js          QR codes and badge images
_backup-original/     the app as it was before the redesign (do not upload)
```
