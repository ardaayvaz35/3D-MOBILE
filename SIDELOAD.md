# Testing on a real iPhone from Windows, without a Mac

This is the workaround used while the Apple Developer Program enrollment is
unresolved. It needs no paid membership and no Mac of your own.

The build happens on a GitHub-hosted macOS runner. The signing happens on your
Windows PC with Sideloadly, using a free Apple ID. ARKit and LiDAR work in this
mode because they need no special entitlement, only the camera permission that
`app.json` already declares.

## One-time setup

1. Push this repository to GitHub. The workflow lives in
   `.github/workflows/ios-unsigned-ipa.yml`.
2. On Windows, install Sideloadly from `sideloadly.io`, plus Apple's own iTunes
   or Apple Devices installer. The Microsoft Store build of iTunes does not
   work with Sideloadly.
3. Sign in to Sideloadly with a free Apple ID. Use the account Apple told you
   is still allowed for on-device development, not a newly created one.
4. Only needed for `Release` builds: add repository secrets
   `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` and, if you use
   it, `EXPO_PUBLIC_VIEWER_URL`. `Debug` builds do not need them, because Metro
   bundles the JS on your PC from your local `.env`.

## Each build

1. Open the Actions tab, pick "iOS unsigned IPA", run the workflow. Leave the
   configuration on `Debug` for LiDAR work.
2. Download the `app-unsigned.ipa` artifact and unzip it.
3. Connect the iPhone by USB, drag the `.ipa` into Sideloadly, start.
4. On the iPhone, open Settings, then General, then VPN & Device Management,
   and trust the developer certificate.

## Daily development

`Debug` produces a development build, so the JS bundle is not embedded. Start
Metro on your PC with `npx expo start --dev-client`, make sure the phone is on
the same Wi-Fi, and open the app. It will ask for the Metro URL the first time.

From then on, JS changes reload over Wi-Fi with no rebuild. You only need a new
IPA when native code changes, which for this project means the
`modules/arkit-capture` Swift sources or anything in `app.json` that affects the
native project.

## Limits to plan around

- The free signature expires after 7 days. Reinstall with Sideloadly to renew.
- A free Apple ID can hold 3 sideloaded apps at once.
- GitHub bills macOS runner minutes at 10x, so a free account has roughly 200
  macOS minutes a month. Prefer `Debug` and iterate over Metro rather than
  rebuilding.
- Push notifications, App Groups and associated domains do not work under free
  provisioning. This project does not use them.

## When enrollment is approved

None of this is needed. EAS Build compiles on Expo's macOS machines and
installs over TestFlight or internal distribution, still with no Mac of your
own. Keep `eas.json` as the path back.
