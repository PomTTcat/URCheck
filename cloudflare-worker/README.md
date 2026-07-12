# URCheck Cloudflare Worker

This is a Cloudflare Workers version of the UR monitor. It is separate from the existing Python/GitHub Actions monitor.

It uses:

- Cloudflare Cron Triggers to run every 10 minutes.
- Cloudflare KV to store the previous room state.
- Telegram Bot API to send alert and heartbeat messages.

## Behavior

- Cron runs every 10 minutes with `*/10 * * * *`.
- The Worker checks rooms only during `07:00-21:59 JST`.
- A heartbeat message is sent once per day during the `09:00-09:59 JST` hour.
- State is stored in KV under `STATE_KEY`, defaulting to `monitor_state`.
- Manual test endpoint:

```text
https://<your-worker>.<your-subdomain>.workers.dev/run?token=<MANUAL_RUN_TOKEN>
https://<your-worker>.<your-subdomain>.workers.dev/run?force_alert=true&token=<MANUAL_RUN_TOKEN>
```

`force_alert=true` treats the current rooms as newly added and sends a test alert to Telegram.

## Setup

Install dependencies:

```powershell
cd cloudflare-worker
npm install
```

Login to Cloudflare:

```powershell
npx wrangler login
```

Create a KV namespace:

```powershell
npx wrangler kv namespace create UR_STATE
```

Copy the returned namespace id into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "UR_STATE",
    "id": "your-kv-namespace-id"
  }
]
```

## Telegram setup

Create a bot:

1. Open Telegram and search for `@BotFather`.
2. Send `/newbot`.
3. Follow the prompts and copy the bot token. It looks like `123456789:AA...`.

Choose where notifications should go:

- For one person: open the new bot chat and send `/start`.
- For multiple people: create a Telegram group, invite both people, then add the bot to the group.

Get `TELEGRAM_CHAT_ID`:

1. Send any message in the bot chat or group, such as `test`.
2. Open this URL in a browser, replacing `<BOT_TOKEN>`:

```text
https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
```

3. Find `chat.id` in the JSON response.

For groups, the id is usually negative, for example:

```text
-1001234567890
```

Set Cloudflare Worker secrets:

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put MANUAL_RUN_TOKEN
```

Recommended values:

```text
TELEGRAM_BOT_TOKEN=<token-from-botfather>
TELEGRAM_CHAT_ID=<chat-id-from-getUpdates>
MANUAL_RUN_TOKEN=<make-a-long-random-string>
```

Deploy:

```powershell
npm run deploy
```

## Local checks

Type-check:

```powershell
npm run typecheck
```

Run locally:

```powershell
npm run dev
```

Test the scheduled handler locally:

```powershell
curl "http://localhost:8787/cdn-cgi/handler/scheduled?format=json"
```

## Notes

Cloudflare Cron Triggers use cron expressions in Cloudflare's scheduler. This Worker runs every 10 minutes all day, then uses JST inside the code to decide whether to do the room check. That avoids relying on local timezone support in the cron expression.
