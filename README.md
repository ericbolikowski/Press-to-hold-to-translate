# Press-to-hold-to-translate

A walkie-talkie-style live translator between two pre-chosen languages, powered
by the OpenAI Realtime API.

Hold (or click-toggle) the button, speak, release. The app detects which of the
two configured languages you spoke and speaks the translation in the other.
Audio playback never starts until you release the button.

## Setup

```bash
npm install
cp .env.example .env
# put your OpenAI API key in .env
npm start
```

Then open <http://localhost:3000>.

On first load you pick the two languages. They're saved in `localStorage`; reopen
the picker any time via the settings gear in the top-right.

## Using it from your phone

Mobile browsers refuse microphone access on plain `http://` unless it's
`localhost`. Opening `http://<your-laptop-LAN-IP>:3000` from your phone will
silently fail. You need HTTPS.

The simplest path is [Tailscale](https://tailscale.com) Serve — it gives you a
valid TLS cert on a private hostname only reachable from your own devices.

```bash
# one-time
# install Tailscale on your laptop and your phone, log into the same account

# each session
npm start &
tailscale serve --bg --https=443 http://localhost:3000
# → https://<your-machine>.<your-tailnet>.ts.net
```

Open that URL on your phone (with Tailscale running) and the mic prompt will
appear normally. Stop sharing with `tailscale serve --https=443 off`.

If you want to share with someone who isn't on your tailnet, swap
`tailscale serve` for `tailscale funnel` — that exposes the same URL on the
public internet. **Heads up**: the URL is unauthenticated, so anyone who finds
it can burn through your OpenAI credits. Don't leave it on.

## How it works

- The browser asks the Node backend (`server.js`) for an **ephemeral Realtime
  session token**. Your OpenAI API key never leaves the server.
- The browser then opens a **WebRTC connection directly to OpenAI** using that
  token. Audio bytes never pass through our backend.
- The session is configured with `turn_detection: 'none'` (manual mode), so the
  model only generates a response when the client sends
  `input_audio_buffer.commit` + `response.create`. That happens **on button
  release**, which is what prevents the model from speaking while you're still
  talking.
- A strict system prompt restricts the model to translation only — it will not
  answer questions or follow instructions contained in your speech.

## Files

- `server.js` — Express server: serves the frontend, mints ephemeral tokens.
- `public/index.html` — UI shell + language picker modal.
- `public/styles.css` — Big button, transcript, modal styling.
- `public/app.js` — WebRTC client, button state machine, transcript rendering.

## Requirements

- Node.js 20+
- A modern browser with `getUserMedia` and WebRTC (Chrome, Firefox, Safari, Edge).
- Microphone permission.
- An OpenAI API key with Realtime API access.
