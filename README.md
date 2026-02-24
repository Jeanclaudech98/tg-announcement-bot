# Telegram Announcement Bot

A simple, robust Telegram bot to manage scheduled announcements in channels. It allows an admin to format messages (with any media type, caption, and entities), add inline buttons, and schedule them for the future or send them immediately.

## Features
- **Media Support**: Send text, photos, videos, albums, and documents with perfect formatting.
- **Inline Buttons**: Easily attach inline URL buttons below the message.
- **Scheduling**: Schedule posts to go out at exact future dates/times.
- **Immediate Broadcasting**: Broadcast instantly to the channel.
- **Persistence**: Survives bot restarts; scheduled jobs are saved in `jobs.db` (SQLite).
- **Security**: Only listens and responds to IDs listed in `ADMIN_IDS`.

## Installation

1. Clone the repository and navigate into the folder.
2. Run `npm install` to install dependencies.
3. Copy `.env.example` to `.env` and fill in your details:
   - `BOT_TOKEN`: Your Telegram Bot API token (from @BotFather).
   - `ADMIN_IDS`: Comma-separated Telegram User IDs allowed to manage the bot (e.g., `123456789,987654321`).
   - `CHANNEL_ID`: The target channel (e.g., `@MyChannel` or `-100123456789`). Ensure the bot is an admin in this channel!

## Usage

Start the bot with:
```bash
node index.js
```

### Bot Commands
Send these directly to the bot in Telegram:
- `/new` - Starts the wizard to create a new announcement.
- `/jobs` - Lists all currently pending scheduled jobs.
- `/deljob <ID>` - Cancels and deletes a scheduled job by its ID.
- `/cancel` - Aborts the current announcement creation wizard.

## How the Wizard Works
1. First, forward or send the exact message (with media, bold text, etc.) to the bot.
2. Next, the bot asks for inline buttons. Reply with:
   `Click Here | https://example.com`
   Or type `none` to skip.
3. Finally, specify a UTC time (e.g., `2024-12-01 15:30`) or type `now`.
