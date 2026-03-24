# SDC Bot

## What it does

### Design Team

Syncs forum posts to a Notion database.

- Watches new threads in one Discord Forum channel.
- Creates a Notion card for each unsynced thread.
- Renames thread titles to `[D-001] Your title` style.
- Writes forum tags into Notion `Tags`.
- Writes thread URL into Notion `Discord URL`.
- Sets status to `To-Do` by default.
- Backfills unsynced threads on startup.

## Required environment variables

Copy `.env.example` to `.env` and set:

- `DISCORD_TOKEN`
- `DISCORD_FORUM_CHANNEL_ID`
- `NOTION_TOKEN`
- `NOTION_DATABASE_ID`

Optional:

- `NOTION_DATA_SOURCE_ID` (if your database has multiple data sources)
- `CARD_PREFIX` (default `D`)
- `CARD_NUMBER_PADDING` (default `3`)

## Install and run

```sh
pnpm install
pnpm start
```

## Bot invite

<https://discord.com/oauth2/authorize?client_id=1485916499884642374&scope=bot&permissions=292057842688>