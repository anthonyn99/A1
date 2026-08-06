# TradeBoard — Security Setup

TradeBoard now uses **real authentication** (Firebase Email/Password) with
**server-enforced Firestore rules**. The login screen is the actual security
boundary — your data is unreadable and unwritable by anyone who isn't signed in
as you, enforced by Google's servers, not just the UI.

## How it works

- **Login:** email + password (Firebase Authentication).
- **Data location:** `tradeboard/{your-uid}` in Firestore.
- **Rules:** `firestore.rules` allows read/write only when
  `request.auth.uid == {your-uid}`. Everything else is denied by default.
- **Remember this device:** the "Keep me signed in" checkbox uses Firebase
  `browserLocalPersistence` — your session survives reloads/restarts until you
  sign out. Uncheck it and the session lasts only until you close the tab.

## One-time setup (you must do this once)

### 1. Enable the Email/Password sign-in provider
1. Open: https://console.firebase.google.com/project/tradeboard-6b2ea/authentication/providers
   (or Firebase Console → **Authentication** → **Sign-in method**)
2. Click **Get started** if prompted.
3. Click **Email/Password**, toggle **Enable** (leave "Email link" off), **Save**.

### 2. Create your account
- Just open https://tradeboard-6b2ea.web.app, click **"Create an account"**,
  enter your email + a password (min 6 chars), and submit. That creates your
  user. **Do this on your MAIN device first** — the one that already has your
  trade data — so it re-seeds into your secure cloud doc automatically.

### 3. Sign in on your other devices
- Open the same URL, sign in with the same email + password. Your data syncs down.

## Rules are already deployed
`firebase deploy --only firestore:rules` has been run. To re-deploy after edits:
```
firebase deploy --only firestore:rules      # rules only
.\deploy.ps1                                 # app (hosting) only
```

## Notes
- The old anonymous shared doc `tradeboard/veda` is now abandoned and locked out
  by the new rules. Your live data comes from your main device's localStorage.
- Forgot your password? Firebase Console → Authentication → your user → reset,
  or add a "Forgot password" email flow later if you want self-service reset.
