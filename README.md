# RestreamA11y

An accessible, keyboard-first desktop app for [Restream](https://restream.io), built for
blind and low-vision streamers. It manages your channels, titles, and stream status, and
reads incoming cross-platform chat aloud with a neural text-to-speech voice.

> **Unofficial project.** RestreamA11y is a community tool and is not affiliated with,
> endorsed by, or supported by Restream. "Restream" is a trademark of its respective owner.

## Why this exists

Streaming dashboards are often difficult or impossible to use with a screen reader. RestreamA11y
is built accessibility-first: every control is reachable by keyboard, every state change is
announced to your screen reader, and incoming chat can be spoken aloud so you can keep up with
your audience without reading the screen.

## Features

- **Channels** — list every destination (YouTube, Facebook, and more) and toggle each on or off.
- **Title and description** — set the title and description that push to your channels.
- **Live chat, spoken aloud** — receive chat from all connected platforms over Restream's chat
  WebSocket, and have each message read out with text-to-speech.
- **Voice controls** — choose the voice, and adjust rate, pitch, and volume. Natural and neural
  voices are listed first when available.
- **Azure Neural TTS (optional)** — connect an Azure Speech key for studio-quality neural voices,
  including the "Andrew" voice. See [Optional: Azure Neural voices](#optional-azure-neural-voices).
- **Stream status and key** — see whether you are live and view your stream key and server.

## Accessibility

Accessibility is the point of this project, not an afterthought:

- Full keyboard control, with a documented shortcut for every action.
- Visible, high-contrast focus indicators on every control.
- Proper semantics throughout: a real tab list, labelled form fields, and switch roles on toggles.
- Screen-reader announcements via ARIA live regions for status changes, channel toggles, and new
  chat messages.
- A high-contrast dark theme that scales with your font size, respects "reduce motion", and honors
  the operating system's high-contrast (forced-colors) mode.
- A skip link as the first focusable element.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Control plus 1 through 6 | Switch between tabs |
| Arrow keys | Move between tabs when a tab is focused |
| Space | Toggle a channel switch or a checkbox |
| R | Refresh live status |
| Escape | Stop speaking |
| Question mark | List all shortcuts |

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer.
- A Restream account.
- A Restream developer application (free to create), used to obtain a Client ID and Client Secret.

## Create your Restream developer app

Each user supplies their own credentials, so you are never sharing keys. In the
[Restream developer portal](https://developers.restream.io/apps), create an app and set:

- **Redirect URI:** `http://localhost:53682/callback`
- **Scopes:** enable `profile.default.read`, `channels.default.read`, `channels.write`,
  `stream.default.read`, and `chat.default.read`. Restream grants scopes from the app
  configuration, so if a feature returns a permission error, enable the matching scope and reconnect.

## Install and run

```bash
npm install
npm start
```

Then, in the app:

1. Open the **Settings** tab (Control plus 6).
2. Enter your **Client ID** and **Client Secret** and save.
3. Choose **Connect to Restream**. Your browser opens for you to approve access, then returns you to
   the app.

## Optional: Azure Neural voices

Windows' built-in Narrator natural voices are locked to Narrator and cannot be used by other apps.
To use a true neural voice such as "Andrew", connect Azure Speech:

1. In the [Azure portal](https://portal.azure.com), create a **Speech service** resource on the
   free F0 tier.
2. Open the resource, then **Keys and Endpoint**, and copy **Key 1** and the **Region**.
3. In the app: **Settings** → *Azure Neural TTS* → paste the Region and Key, then save.
4. In **Voice / TTS**, set the engine to **Azure Neural**, choose a voice, and test it.

The key is stored encrypted and never leaves your machine. Synthesis runs locally through the app's
main process. The free tier covers 500,000 characters per month.

## Where your data is stored

Credentials and tokens are stored outside this project folder, in your user data directory
(`%APPDATA%/restream-a11y/` on Windows). Tokens are encrypted using the operating system keychain
via Electron's safeStorage. Nothing sensitive is kept in the repository.

## Verified Restream API endpoints

For reference, these are the endpoints the app uses (verified against the Restream documentation):

| Purpose | Method and path | Scope |
| --- | --- | --- |
| Authorize | `GET https://api.restream.io/login` | — |
| Token and refresh | `POST https://api.restream.io/oauth/token` | — |
| Profile | `GET /v2/user/profile` | profile.default.read |
| List channels | `GET /v2/user/channel/all` | channels.default.read |
| Toggle channel | `PATCH /v2/user/channel/{id}` | channels.write |
| Get or set title | `GET` or `PATCH /v2/user/channel-meta/{id}` | channels.read or channels.write |
| Delete channel | `DELETE /v2/user/channels/{id}` (note: plural) | channels.write |
| Stream key | `GET /v2/user/streamKey` | stream.default.read |
| Live chat | `wss://chat.api.restream.io/ws?accessToken=...` | chat.default.read |

## Developer scripts

The `scripts/` folder holds optional command-line helpers used during development. They read your
saved configuration and require Electron (run with `npx electron scripts/<name>.js`):

- `verify.js` — connects and prints a status report (profile, channels, stream key).

## Tech stack

[Electron](https://www.electronjs.org/) with a plain HTML, CSS, and JavaScript renderer. No UI
framework, to keep the accessibility tree simple and predictable.

## Contributing

Issues and pull requests are welcome, especially ones that improve screen-reader behavior or add
accessibility. Please keep the keyboard-first, screen-reader-first principles intact.

## License

Released under the [MIT License](LICENSE).
