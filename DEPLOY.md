# Putting NetWorth on Netlify

This folder is the finished website. There is no build step.

```
public/                     the site itself (this is what Netlify serves)
netlify/functions/fetch.mjs the price relay used by "Update"
netlify.toml                tells Netlify about both
```

## Why there is a relay

Browsers are not allowed to download AMFI, BSE, NSE, NPS Trust or IBJA files
directly (those sites don't permit it). So "Update" asks your own
Netlify site to fetch them. Only these public price files pass through it;
your portfolio never leaves the phone.

There are two ways to deploy. Both work offline once installed. They differ
only in how well "Update" can talk to the exchanges.

## Option A: with the relay function (recommended)

This gives the most complete updates, including NSE corporate actions.

**From a computer with Node.js installed:**

```
npm install -g netlify-cli
netlify login
cd networth-web          # this folder
netlify deploy --prod    # first time: choose "Create & configure a new site"
```

**Or from GitHub:** put this folder in a repository, then in Netlify choose
*Add new site → Import an existing project*. Leave the build command empty;
`netlify.toml` already sets `public` as the publish directory and
`netlify/functions` as the functions directory.

## Option B: drag and drop (no tools needed)

1. Log in at <https://app.netlify.com> (a site dropped while logged out is
   deleted after an hour).
2. Open <https://app.netlify.com/drop> and drag the **`public`** folder onto the
   page.

Drag-and-drop sites cannot run functions, so the app falls back to the
simple proxy rules in `public/_redirects`. Share prices, fund NAVs, NPS NAVs
and BSE corporate actions still update. NSE's corporate-action feed usually
needs the function, but BSE covers the same events.

## Installing on phones and tablets

The first visit downloads about 25 MB once (use Wi-Fi). After that, the app
works without internet; only **Update** needs it.

- **iPhone / iPad (Safari):** open the site, tap **Share → Add to Home Screen**.
  Always open it from the home-screen icon: iOS keeps installed web apps'
  data, but may clear data of sites only visited in a browser tab.
- **Android (Chrome):** open the site, tap **Install app** (or menu ⋮ → Add to
  Home screen).
- **Computer:** Chrome or Edge show an install icon in the address bar.

## Unlock with Face ID, Touch ID or fingerprint

With **Lock (encryption)** on, the app can open with the phone's own screen
lock instead of the password. It works only in the installed app (opened from
the home-screen icon), and needs **iOS / iPadOS 18 or newer** on iPhone and
iPad, or a recent Chrome on Android.

1. **More → Settings → Privacy**: turn on **Lock (encryption)** and choose a
   password (write it down - it cannot be recovered).
2. Turn on **Unlock with Face ID / Touch ID** (Android: *fingerprint or screen
   lock*) and type the password once.
3. Tap **Continue**. The phone asks to save a **passkey** for NetWorth -
   allow it and look at the phone (or touch the sensor).
4. iPhone and iPad then ask for **One more step**: tap **Confirm** and use
   Face ID / Touch ID once more.

From then on the locked app shows **Unlock with Face ID / Touch ID**. The
password still works too (keep it: exported Excel files, other devices and
the desktop app need it). Set it up on each device separately. If you
change the password, the app asks you to confirm with Face ID so the unlock
keeps working. The passkey is listed in the phone's Passwords app as
"NetWorth (iPhone)" / "NetWorth (iPad)"; deleting it there stops the
device unlock (the password still opens the app).

## First use

Open the app and choose **Import my Excel file**. Pick your
`Family_Portfolio_Tracker.xlsx`; everything comes across. Then tap
**Update** (top right).

## Keeping your data safe

Data lives only on that device (each phone has its own copy). Use
**More → Your data → Export to Excel** now and then, and keep the file in
Files, Drive or email. That file is also how you move data to another device:
export on one, import on the other. It opens in Excel and works with the
desktop *Update Portfolio* app.

## Updating the app

Deploy the new folder the same way. Installed copies pick it up the next time
they are opened with internet; close and reopen once to switch over.
