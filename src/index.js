import "dotenv/config";

import { Client as NotionClient } from "@notionhq/client";
import { ChannelType, Client as DiscordClient, Events, GatewayIntentBits } from "discord.js";

const NOTION_TAGS_PROPERTY = "Tags";
const NOTION_THREAD_URL_PROPERTY = "Discord URL";
const NOTION_STATUS_PROPERTY = "Status";
const STATUS_OPTIONS = ["To-Do", "In Progress", "Completed"];

const requiredEnvVars = ["DISCORD_TOKEN", "DISCORD_FORUM_CHANNEL_ID", "NOTION_TOKEN", "NOTION_DATABASE_ID"];

for (const key of requiredEnvVars) {
	if (!process.env[key]) {
		throw new Error(`Missing environment variable: ${key}`);
	}
}

const config = {
	discordToken: process.env.DISCORD_TOKEN,
	forumChannelId: process.env.DISCORD_FORUM_CHANNEL_ID,
	notionToken: process.env.NOTION_TOKEN,
	notionDatabaseId: process.env.NOTION_DATABASE_ID,
	notionDataSourceId: process.env.NOTION_DATA_SOURCE_ID,
	idPrefix: process.env.CARD_PREFIX ?? "D",
	idPadding: Number.parseInt(process.env.CARD_NUMBER_PADDING ?? "3", 10)
};

const inFlightThreadIds = new Set();
let notionContextPromise;
let forumStatusTagIdsPromise;

const discord = new DiscordClient({
	intents: [GatewayIntentBits.Guilds]
});

const notion = new NotionClient({ auth: config.notionToken });

discord.once(Events.ClientReady, async client => {
	console.log(`Discord bot logged in as ${client.user.tag}`);

	await getForumStatusTagIds(client).catch(error => {
		console.error("Failed to ensure forum status tags:", error);
	});

	await backfillUnsyncedThreads(client).catch(error => {
		console.error("Failed to run startup sync:", error);
	});
});

discord.on(Events.ThreadCreate, async (thread, newlyCreated) => {
	if (!newlyCreated || thread.parentId !== config.forumChannelId) {
		return;
	}

	if (thread.parent?.type !== ChannelType.GuildForum) {
		return;
	}

	await syncThreadToNotion(thread, { reason: "thread_created", forumChannel: thread.parent });
});

await discord.login(config.discordToken);

async function backfillUnsyncedThreads(client) {
	const channel = await getForumChannel(client);
	if (!channel || channel.type !== ChannelType.GuildForum) {
		throw new Error("DISCORD_FORUM_CHANNEL_ID is not a forum channel");
	}

	const [activeResult, archivedResult] = await Promise.all([channel.threads.fetchActive(), channel.threads.fetchArchived().catch(() => ({ threads: new Map() }))]);

	const allThreads = new Map();
	for (const [id, thread] of activeResult.threads) {
		allThreads.set(id, thread);
	}
	for (const [id, thread] of archivedResult.threads) {
		allThreads.set(id, thread);
	}

	for (const thread of allThreads.values()) {
		await syncThreadToNotion(thread, { reason: "startup_backfill", forumChannel: channel });
	}
}

async function syncThreadToNotion(thread, { reason, forumChannel }) {
	if (inFlightThreadIds.has(thread.id)) {
		return;
	}

	inFlightThreadIds.add(thread.id);

	try {
		const context = await getNotionContext();
		const statusTagIds = await getForumStatusTagIds(discord);

		const appliedTagNames = getAppliedTagNames(thread, forumChannel);
		let statusName = appliedTagNames.find(name => STATUS_OPTIONS.includes(name));
		if (!statusName) {
			statusName = "To-Do";
			const defaultStatusTagId = statusTagIds.get("To-Do");
			if (defaultStatusTagId) {
				const nextTags = [...new Set([...thread.appliedTags, defaultStatusTagId])];
				await thread.setAppliedTags(nextTags);
			}
		}

		const effectiveStatus = context.statusOptionNames.includes(statusName) ? statusName : (context.statusOptionNames[0] ?? "To-Do");
		const contentTagNames = appliedTagNames.filter(name => !STATUS_OPTIONS.includes(name));

		const alreadySynced = await isThreadAlreadySynced({ thread, context });
		if (alreadySynced) {
			return;
		}

		const serial = await getNextSerial({
			notion,
			dataSourceId: context.dataSourceId,
			titlePropertyName: context.titlePropertyName,
			idPrefix: config.idPrefix
		});

		const cardCode = `${config.idPrefix}-${String(serial).padStart(config.idPadding, "0")}`;
		const normalizedThreadTitle = thread.name.replace(/^\[[A-Za-z]-\d+\]\s*/u, "").trim();
		const newThreadTitle = `[${cardCode}] ${normalizedThreadTitle}`;

		const properties = {
			[context.titlePropertyName]: {
				title: [{ text: { content: `${newThreadTitle}` } }]
			},
			[NOTION_TAGS_PROPERTY]: {
				multi_select: contentTagNames.map(name => ({ name }))
			},
			[NOTION_THREAD_URL_PROPERTY]: {
				url: thread.url
			},
			[NOTION_STATUS_PROPERTY]: {
				status: { name: effectiveStatus }
			}
		};

		const notionPage = await notion.pages.create({
			parent: { data_source_id: context.dataSourceId },
			properties,
			children: [
				{
					object: "block",
					type: "paragraph",
					paragraph: {
						rich_text: [{ type: "text", text: { content: `Discord thread: ${thread.url}` } }]
					}
				}
			]
		});

		if (thread.name !== newThreadTitle) {
			await thread.setName(newThreadTitle);
		}

		await thread.send({
			content: `已建立 Notion 卡片：${notionPage.url}`
		});
	} catch (error) {
		console.error("Failed to sync forum post to Notion:", error);
		const text = getSyncErrorText(error, reason);
		await thread.send(text).catch(() => undefined);
	} finally {
		inFlightThreadIds.delete(thread.id);
	}
}

async function getNotionContext() {
	if (!notionContextPromise) {
		notionContextPromise = (async () => {
			const database = await notion.databases.retrieve({
				database_id: config.notionDatabaseId
			});

			const dataSourceId = config.notionDataSourceId ?? database.data_sources[0]?.id;
			if (!dataSourceId) {
				throw new Error("No data source found. Set NOTION_DATA_SOURCE_ID in .env");
			}

			await ensureNotionProperties(dataSourceId);

			const dataSource = await notion.dataSources.retrieve({ data_source_id: dataSourceId });
			const titlePropertyName = Object.entries(dataSource.properties).find(([, value]) => value.type === "title")?.[0];

			if (!titlePropertyName) {
				throw new Error("No title property found in Notion data source");
			}

			assertPropertyType(dataSource.properties, NOTION_TAGS_PROPERTY, "multi_select");
			assertPropertyType(dataSource.properties, NOTION_THREAD_URL_PROPERTY, "url");
			assertPropertyType(dataSource.properties, NOTION_STATUS_PROPERTY, "status");

			const statusProperty = dataSource.properties[NOTION_STATUS_PROPERTY];
			const statusOptionNames = statusProperty.type === "status" ? statusProperty.status.options.map(option => option.name) : [];

			return {
				dataSourceId,
				titlePropertyName,
				statusOptionNames
			};
		})();
	}

	return notionContextPromise;
}

async function isThreadAlreadySynced({ thread, context }) {
	if (hasCardPrefix(thread.name)) {
		return true;
	}

	const response = await notion.dataSources.query({
		data_source_id: context.dataSourceId,
		filter: {
			property: NOTION_THREAD_URL_PROPERTY,
			url: { equals: thread.url }
		},
		page_size: 1
	});

	return response.results.length > 0;
}

async function getNextSerial({ notion, dataSourceId, titlePropertyName, idPrefix }) {
	const regex = new RegExp(`^\\[${escapeRegExp(idPrefix)}-(\\d+)\\]`, "u");
	let cursor;
	let max = 0;

	do {
		const response = await notion.dataSources.query({
			data_source_id: dataSourceId,
			start_cursor: cursor,
			page_size: 100
		});

		for (const page of response.results) {
			if (!("properties" in page)) {
				continue;
			}

			const titleProp = page.properties[titlePropertyName];
			if (!titleProp || titleProp.type !== "title") {
				continue;
			}

			const text = titleProp.title.map(part => part.plain_text).join("");
			const matched = text.match(regex);
			if (!matched) {
				continue;
			}

			const current = Number.parseInt(matched[1], 10);
			if (!Number.isNaN(current) && current > max) {
				max = current;
			}
		}

		cursor = response.has_more ? response.next_cursor : undefined;
	} while (cursor);

	return max + 1;
}
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasCardPrefix(title) {
	return /^\[[A-Za-z]-\d+\]\s*/u.test(title);
}

async function ensureNotionProperties(dataSourceId) {
	const dataSource = await notion.dataSources.retrieve({ data_source_id: dataSourceId });
	const patch = {};

	if (!dataSource.properties[NOTION_TAGS_PROPERTY]) {
		patch[NOTION_TAGS_PROPERTY] = {
			multi_select: {
				options: []
			}
		};
	}

	if (!dataSource.properties[NOTION_THREAD_URL_PROPERTY]) {
		patch[NOTION_THREAD_URL_PROPERTY] = {
			url: {}
		};
	}

	if (!dataSource.properties[NOTION_STATUS_PROPERTY]) {
		patch[NOTION_STATUS_PROPERTY] = {
			status: {
				options: [
					{ name: "To-Do", color: "default" },
					{ name: "In Progress", color: "blue" },
					{ name: "Completed", color: "green" }
				]
			}
		};
	}

	if (Object.keys(patch).length > 0) {
		await notion.dataSources.update({
			data_source_id: dataSourceId,
			properties: patch
		});
	}
}

function assertPropertyType(properties, propertyName, expectedType) {
	const property = properties[propertyName];
	if (!property) {
		throw new Error(`Property not found in Notion data source: ${propertyName}`);
	}

	if (property.type !== expectedType) {
		throw new Error(`Property ${propertyName} must be type ${expectedType}, got ${property.type}`);
	}
}

async function getForumStatusTagIds(client) {
	if (!forumStatusTagIdsPromise) {
		forumStatusTagIdsPromise = (async () => {
			const forumChannel = await getForumChannel(client);
			const existing = new Map(forumChannel.availableTags.map(tag => [tag.name, tag.id]));
			const missing = STATUS_OPTIONS.filter(name => !existing.has(name));

			if (missing.length > 0) {
				const updated = await forumChannel.setAvailableTags([
					...forumChannel.availableTags.map(tag => ({
						id: tag.id,
						name: tag.name,
						moderated: tag.moderated,
						emojiId: tag.emojiId,
						emojiName: tag.emojiName
					})),
					...missing.map(name => ({ name, moderated: false }))
				]);

				return new Map(updated.availableTags.map(tag => [tag.name, tag.id]));
			}

			return existing;
		})();
	}

	return forumStatusTagIdsPromise;
}

async function getForumChannel(client) {
	const channel = await client.channels.fetch(config.forumChannelId);
	if (!channel || channel.type !== ChannelType.GuildForum) {
		throw new Error("DISCORD_FORUM_CHANNEL_ID is not a forum channel");
	}

	return channel;
}

function getAppliedTagNames(thread, forumChannel) {
	const tagsById = new Map(forumChannel.availableTags.map(tag => [tag.id, tag.name]));
	return thread.appliedTags.map(tagId => tagsById.get(tagId)).filter(Boolean);
}

function getSyncErrorText(error, reason) {
	const base = "建立 Notion 卡片失敗，請檢查 bot 設定與權限。";
	if (!error || typeof error !== "object") {
		return base;
	}

	if ("code" in error && error.code === 429) {
		return `${base}（Notion API rate limit）`;
	}

	if (reason === "startup_backfill") {
		return `${base}（啟動補同步時發生錯誤）`;
	}

	return base;
}
