# Store checklist - Patente B

## Before building
1. Choose the app name (e.g. "Nozhdar Quiz") and check it is free on App Store and Google Play.
2. Apple Developer account (99 USD/year) and Google Play Console account (25 USD once).
3. Publish privacy.html (GitHub Pages: repo Settings > Pages > Deploy from branch main) and copy its URL.

## App Store Connect
- Name, subtitle, description (English and Italian), keywords.
- Category: Education. Age rating: 4+ (no violence, no user content).
- Privacy policy URL: the GitHub Pages URL above.
- Support URL: an Instagram profile or an email page.
- App Privacy: Contact info (email only for admin), Identifiers (account name), Diagnostics (none). No tracking.
- Review notes: give a TEST ACCOUNT (name + password created by you in the admin panel, never paste it in public chat).
  Explain: "Accounts are created by the owner. Use the test account to sign in. Account deletion is in the home screen at the bottom."

## Google Play Console
- Data safety form: same answers as above.
- Content rating questionnaire: all "No" (Education app).
- Target audience: 18+ or 13+.
- Closed testing: with 12 testers for 14 days before production (new personal accounts).

## Important rules (read before submitting)
- The store app is FREE and contains NO payment or purchase link. Charging people outside the app for access to an app downloaded from the store is not allowed by Apple or Google.
- If you want to charge for access, the payment must go through In-App Purchase (Apple takes 15-30%, Google takes 15-30%). Otherwise publish the web version (the same site) without the store.
- Question text belongs to the GitHub project owner. Make sure you have the right to use it.

## Build
- Upload the zip to a private GitHub repo, then connect the repo to Codemagic.
- Run the "ios-app-store" and "android-play-store" workflows.
