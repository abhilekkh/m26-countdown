# M# 2026 Live Countdown

- `/` – display screen (open on the HDMI laptop, press **F** or double-click for fullscreen)
- `/admin` – remote control (phone/laptop): announcements with review → submit, custom timer, theme

Changes from `/admin` reach the display instantly over Server-Sent Events; no refresh needed.

## Run locally
```
ADMIN_PIN=123456 node server.js
```
Env: `PORT` (default 3000), `ADMIN_PIN`, `DATA_DIR` (state file location).

## Deploy
Render: New → Blueprint → pick this repo (uses `render.yaml`), set `ADMIN_PIN`.
