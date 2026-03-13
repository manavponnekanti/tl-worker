# sundries-worker

A Cloudflare Worker that turns a Telegram bot into a microblog CMS. Send a message (text or photo) to your bot and it commits a markdown file to a GitHub repo. Edit or delete posts directly from Telegram.

## How it works

- **Create**: Send a message → worker commits `{timestamp}.md` to your GitHub repo and uploads any photo to R2
- **Edit**: Edit your Telegram message → worker updates the markdown file on GitHub (preserving the original date)
- **Delete**: Reply `/delete` to your original message → worker removes the file from GitHub and the image from R2

Bot confirmations auto-delete after 5 seconds to keep the chat clean.

A KV namespace maps Telegram message IDs to post slugs, since Telegram's `edited_message` webhook only includes the message ID.

## Setup

### Prerequisites

- A Cloudflare account with Workers, R2, and KV enabled
- A Telegram bot (create one via [@BotFather](https://t.me/BotFather))
- A GitHub repo where posts will be committed
- A GitHub personal access token with `contents` write permission on that repo

### 1. Install dependencies

```sh
npm install
```

### 2. Create the KV namespace

```sh
npx wrangler kv namespace create SUNDRIES
```

### 3. Configure `wrangler.toml`

Fill in your R2 bucket name and the KV namespace ID from step 2.

### 4. Set secrets

```sh
npx wrangler secret put TELEGRAM_TOKEN    # bot token from BotFather
npx wrangler secret put TELEGRAM_USER_ID  # your Telegram user ID (numeric)
npx wrangler secret put GITHUB_PAT        # GitHub personal access token
npx wrangler secret put GITHUB_REPO       # owner/repo, e.g. "octocat/blog"
npx wrangler secret put PUBLIC_URL        # URL where posts are visible, e.g. "https://example.com/sundries/"
npx wrangler secret put R2_PUBLIC_URL     # public URL for your R2 bucket, e.g. "https://files.example.com"
```

### 5. Deploy

```sh
npx wrangler deploy
```

### 6. Set the Telegram webhook

```sh
curl "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://sundries-worker.<your-subdomain>.workers.dev/webhook"
```

## Post format

Each post is a markdown file committed to `src/content/sundries/{slug}.md`:

```markdown
---
date: 2025-01-15T12:00:00.000Z
slug: "1736942400"
---
Your message text

<img src="https://files.example.com/sundries/1736942400.jpg" width="400" height="300" alt="">
```

The slug is a Unix timestamp. Images are resized in the markdown to a max height of 300px (the original is stored at full resolution in R2).

## Customization

The content path (`src/content/sundries/`) and R2 key prefix (`sundries/`) are set in `index.ts`. Change them to match your site structure.
