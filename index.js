require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const LocalSession = require('telegraf-session-local');
const schedule = require('node-schedule');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
    .split(',')
    .map((id) => Number.parseInt(id.trim(), 10))
    .filter((id) => Number.isFinite(id));
const CHANNEL_ID = process.env.CHANNEL_ID;

if (!BOT_TOKEN || ADMIN_IDS.length === 0 || !CHANNEL_ID) {
    console.error('Missing or invalid BOT_TOKEN, ADMIN_IDS, or CHANNEL_ID in environment.');
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const ADMIN_ID_SET = new Set(ADMIN_IDS);
const JOBS_DB_FILE = path.join(__dirname, 'jobs.db');
const pendingMediaGroups = new Map();
const db = new Database(JOBS_DB_FILE);

db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        messageId INTEGER,
        messageIds TEXT,
        fromChatId TEXT NOT NULL,
        reply_markup TEXT
    )
`);

const getServerTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
const formatInTimeZone = (date, timeZone) => new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone,
    timeZoneName: 'short'
}).format(date);

const formatSchedulePreview = (date) => {
    const serverTimeZone = getServerTimeZone();
    return `UTC: ${formatInTimeZone(date, 'UTC')}\nServer (${serverTimeZone}): ${formatInTimeZone(date, serverTimeZone)}`;
};

// Session middleware for conversation state
const localSession = new LocalSession({ database: 'sessions.json' });
bot.use(localSession.middleware());

// Restrict to admin
bot.use((ctx, next) => {
    if (ctx.from && ADMIN_ID_SET.has(ctx.from.id)) {
        return next();
    } else if (ctx.chat && ctx.chat.type === 'private') {
        return ctx.reply('⛔ Unauthorized. You are not the admin.');
    }
    return undefined;
});

const parseJsonColumn = (jsonValue, fallbackValue) => {
    if (!jsonValue) return fallbackValue;
    try {
        return JSON.parse(jsonValue);
    } catch (error) {
        return fallbackValue;
    }
};

const mapJobRow = (row) => ({
    id: row.id,
    date: row.date,
    messageId: row.messageId ?? undefined,
    messageIds: parseJsonColumn(row.messageIds, undefined),
    fromChatId: row.fromChatId,
    reply_markup: parseJsonColumn(row.reply_markup, undefined)
});

const getJobsStmt = db.prepare(`
    SELECT id, date, messageId, messageIds, fromChatId, reply_markup
    FROM jobs
    ORDER BY date ASC
`);
const insertJobStmt = db.prepare(`
    INSERT INTO jobs (id, date, messageId, messageIds, fromChatId, reply_markup)
    VALUES (@id, @date, @messageId, @messageIds, @fromChatId, @reply_markup)
`);
const deleteJobStmt = db.prepare('DELETE FROM jobs WHERE id = ?');
const deletePastOrInvalidJobsStmt = db.prepare(`
    DELETE FROM jobs
    WHERE date <= @now OR date IS NULL OR fromChatId IS NULL OR id IS NULL
`);

const getJobs = () => getJobsStmt.all().map(mapJobRow);

const saveJob = (job) => {
    insertJobStmt.run({
        id: job.id,
        date: job.date,
        messageId: job.messageId ?? null,
        messageIds: job.messageIds ? JSON.stringify(job.messageIds) : null,
        fromChatId: String(job.fromChatId),
        reply_markup: job.reply_markup ? JSON.stringify(job.reply_markup) : null
    });
};

const safeReply = async (ctx, text, extra = {}) => {
    try {
        return await ctx.reply(text, extra);
    } catch (error) {
        console.error('Failed to reply to user:', error.message);
        return null;
    }
};

const notifyAdmin = async (text) => {
    for (const adminId of ADMIN_IDS) {
        try {
            await bot.telegram.sendMessage(adminId, text);
        } catch (error) {
            console.error(`Failed to notify admin ${adminId}:`, error.message);
        }
    }
};

const parseScheduleInput = (input) => {
    const text = input.trim();
    const explicitPattern = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?:\s*(UTC|Z|[+\-]\d{2}:?\d{2}))?$/i;
    const match = explicitPattern.exec(text);

    if (!match) {
        const fallback = new Date(text);
        if (!Number.isNaN(fallback.getTime()) && /[zZ]|[+\-]\d{2}:?\d{2}|GMT|UTC/.test(text)) {
            return {
                date: fallback,
                assumedUtcDefault: false
            };
        }
        return { date: null, assumedUtcDefault: false };
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const timezoneToken = (match[6] || '').toUpperCase();

    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
        return { date: null, assumedUtcDefault: false };
    }

    const utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const utcDate = new Date(utcMs);
    if (
        utcDate.getUTCFullYear() !== year ||
        utcDate.getUTCMonth() !== month - 1 ||
        utcDate.getUTCDate() !== day
    ) {
        return { date: null, assumedUtcDefault: false };
    }

    if (!timezoneToken || timezoneToken === 'UTC' || timezoneToken === 'Z') {
        return {
            date: utcDate,
            assumedUtcDefault: !timezoneToken
        };
    }

    const tzMatch = /^([+\-])(\d{2}):?(\d{2})$/.exec(timezoneToken);
    if (!tzMatch) {
        return { date: null, assumedUtcDefault: false };
    }

    const sign = tzMatch[1] === '+' ? 1 : -1;
    const offsetHours = Number(tzMatch[2]);
    const offsetMinutes = Number(tzMatch[3]);
    if (offsetHours > 23 || offsetMinutes > 59) {
        return { date: null, assumedUtcDefault: false };
    }

    const offsetMs = sign * ((offsetHours * 60 + offsetMinutes) * 60 * 1000);
    return {
        date: new Date(utcMs - offsetMs),
        assumedUtcDefault: false
    };
};

const isSupportedSourceMessage = (message) => {
    if (!message) return false;
    if (message.has_protected_content) return false;
    const supportedKeys = [
        'text',
        'photo',
        'video',
        'document',
        'animation',
        'audio',
        'voice',
        'video_note',
        'sticker'
    ];
    return supportedKeys.some((key) => Object.prototype.hasOwnProperty.call(message, key));
};

const copyAnnouncement = async (announcement) => {
    const messageIds = Array.isArray(announcement.messageIds) ? announcement.messageIds : null;
    const hasMediaGroup = messageIds && messageIds.length > 1;

    if (hasMediaGroup) {
        try {
            await bot.telegram.callApi('copyMessages', {
                chat_id: CHANNEL_ID,
                from_chat_id: announcement.fromChatId,
                message_ids: messageIds
            });
        } catch (error) {
            console.error('copyMessages failed, falling back to per-message copy:', error.message);
            for (const id of messageIds) {
                await bot.telegram.copyMessage(CHANNEL_ID, announcement.fromChatId, id);
            }
        }

        if (announcement.reply_markup) {
            await bot.telegram.sendMessage(CHANNEL_ID, 'Links:', {
                reply_markup: announcement.reply_markup
            });
        }
        return;
    }

    const messageId = messageIds && messageIds.length === 1 ? messageIds[0] : announcement.messageId;
    if (!messageId) {
        throw new Error('Missing source message ID.');
    }

    await bot.telegram.copyMessage(CHANNEL_ID, announcement.fromChatId, messageId, {
        reply_markup: announcement.reply_markup
    });
};

const executeJob = async (job) => {
    try {
        await copyAnnouncement(job);
        await notifyAdmin(`✅ Scheduled announcement executed successfully!\nID: \`${job.id}\``);
        console.log(`Job ${job.id} executed successfully.`);
    } catch (error) {
        await notifyAdmin(`❌ Failed to execute scheduled announcement (ID: \`${job.id}\`):\n${error.message}`);
        console.error(`Job ${job.id} failed:`, error.message);
    } finally {
        deleteJobStmt.run(job.id);
    }
};

const loadJobs = () => {
    deletePastOrInvalidJobsStmt.run({ now: new Date().toISOString() });
    const jobs = getJobs();
    let loadedCount = 0;

    jobs.forEach(job => {
        if (!job || !job.id || !job.date || !job.fromChatId) {
            deleteJobStmt.run(job.id);
            return;
        }
        const jobDate = new Date(job.date);
        if (Number.isNaN(jobDate.getTime()) || jobDate <= new Date()) {
            deleteJobStmt.run(job.id);
            return;
        }
        const scheduled = schedule.scheduleJob(job.id, jobDate, () => executeJob(job));
        if (scheduled) {
            loadedCount++;
        } else {
            console.error(`Skipping job ${job.id}: scheduler rejected date ${job.date}`);
        }
    });
    console.log(`Loaded ${loadedCount} scheduled jobs.`);
};

bot.command('start', (ctx) => {
    ctx.session.step = null;
    ctx.session.draft = null;
    safeReply(ctx, '👋 Welcome to the Announcement Bot.\n\nCommands:\n/new - Create a new announcement\n/jobs - View scheduled jobs\n/cancel - Cancel current operation');
});

bot.command('cancel', (ctx) => {
    ctx.session.step = null;
    ctx.session.draft = null;
    safeReply(ctx, '❌ Cancelled current operation.');
});

bot.command('new', (ctx) => {
    ctx.session.step = 'awaiting_message';
    ctx.session.draft = {};
    safeReply(ctx, '1️⃣ Send me the message, photo, video, or document you want to announce.\n*(Formatting and media will be preserved exactly as you send it.)*', { parse_mode: 'Markdown' });
});

bot.command('jobs', (ctx) => {
    const jobs = getJobs();
    const pending = jobs.filter(j => new Date(j.date) > new Date());

    if (pending.length === 0) return safeReply(ctx, '📭 No scheduled announcements.');

    let msg = '📅 *Scheduled Announcements:*\n\n';
    pending.forEach((j, i) => {
        const date = new Date(j.date);
        msg += `${i + 1}. ${formatSchedulePreview(date)}\nID: \`${j.id}\`\n\n`;
    });
    msg += 'To delete a job, use `/deljob <ID>`';
    safeReply(ctx, msg, { parse_mode: 'Markdown' });
});

bot.command('deljob', (ctx) => {
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) return safeReply(ctx, '⚠️ Provide an ID: `/deljob <ID>`');

    const id = parts[1];
    const deleted = deleteJobStmt.run(id);
    if (deleted.changes > 0) {
        schedule.cancelJob(id);
        safeReply(ctx, `✅ Job \`${id}\` cancelled and deleted.`, { parse_mode: 'Markdown' });
    } else {
        safeReply(ctx, '❌ Job ID not found.');
    }
});

bot.on('message', async (ctx) => {
    if (ctx.message.text && ctx.message.text.startsWith('/')) return; // Ignore unhandled commands

    const step = ctx.session.step;
    if (!step) return;

    if (step === 'awaiting_message') {
        if (!isSupportedSourceMessage(ctx.message)) {
            return safeReply(ctx, '⚠️ This message type cannot be copied by Telegram. Send text, photo, video, document, animation, audio, voice, video note, or sticker.');
        }

        if (ctx.message.media_group_id) {
            const groupKey = `${ctx.chat.id}:${ctx.from.id}:${ctx.message.media_group_id}`;
            const existing = pendingMediaGroups.get(groupKey) || {
                messageIds: [],
                timer: null,
                ctx
            };
            if (!existing.messageIds.includes(ctx.message.message_id)) {
                existing.messageIds.push(ctx.message.message_id);
            }

            if (existing.timer) clearTimeout(existing.timer);
            existing.timer = setTimeout(async () => {
                const data = pendingMediaGroups.get(groupKey);
                if (!data) return;
                pendingMediaGroups.delete(groupKey);

                // Keep order stable for copyMessages.
                const sortedIds = data.messageIds.sort((a, b) => a - b);
                if (!data.ctx.session || data.ctx.session.step !== 'awaiting_message') return;

                data.ctx.session.draft.messageIds = sortedIds;
                data.ctx.session.draft.fromChatId = data.ctx.chat.id;
                data.ctx.session.step = 'awaiting_buttons';

                await safeReply(
                    data.ctx,
                    `2️⃣ Album saved (${sortedIds.length} items).\n\nNow, send inline buttons like:\n\`Button Text | https://link.com\`\n*(One per line)*\n\nOr reply with "none".\n\nNote: For albums, buttons will be posted as a separate "Links" message due to Telegram API limits.`,
                    { parse_mode: 'Markdown' }
                );
            }, 1200);

            pendingMediaGroups.set(groupKey, existing);
            return;
        }

        ctx.session.draft.messageId = ctx.message.message_id;
        ctx.session.draft.fromChatId = ctx.chat.id;
        ctx.session.step = 'awaiting_buttons';
        return safeReply(ctx, '2️⃣ Message saved!\n\nNow, send me the inline buttons formatted like:\n`Button Text | https://link.com`\n*(One per line)*\n\nOr simply reply with "none" to skip buttons.', { parse_mode: 'Markdown' });
    }
    if (step === 'awaiting_buttons') {
        const text = ctx.message.text || '';
        let reply_markup = undefined;

        if (!text.trim()) {
            return safeReply(ctx, '⚠️ Send button definitions as plain text, or type "none" to skip.');
        }

        if (text.toLowerCase() !== 'none') {
            const buttons = [];
            const lines = text.split('\n');
            for (let line of lines) {
                const parts = line.split('|').map(s => s.trim());
                if (parts.length >= 2) {
                    const btnText = parts[0];
                    const url = parts.slice(1).join('|'); // In case URL contains |
                    if (btnText && /^https?:\/\//i.test(url)) {
                        buttons.push([Markup.button.url(btnText, url)]);
                    }
                }
            }
            if (buttons.length > 0) {
                reply_markup = { inline_keyboard: buttons };
                await safeReply(ctx, `✅ Added ${buttons.length} buttons.`);
            } else {
                return safeReply(ctx, '⚠️ Invalid format. Try again or type "none".');
            }
        } else {
            await safeReply(ctx, '⏭️ Skipped buttons.');
        }

        ctx.session.draft.reply_markup = reply_markup;
        ctx.session.step = 'awaiting_schedule';

        return safeReply(
            ctx,
            '3️⃣ Almost done! When should I post this?\n\n- Type "now" to post immediately.\n- Send `YYYY-MM-DD HH:MM` (defaults to UTC).\n- Or include timezone explicitly: `YYYY-MM-DD HH:MM UTC` or `YYYY-MM-DD HH:MM -05:00`.',
            { parse_mode: 'Markdown' }
        );
    }
    if (step === 'awaiting_schedule') {
        const text = (ctx.message.text || '').trim();
        if (!text) {
            return safeReply(ctx, '⚠️ Send "now" or a valid date/time.');
        }

        if (text.toLowerCase() === 'now') {
            try {
                await copyAnnouncement(ctx.session.draft);
                await safeReply(ctx, '✅ Sent immediately to the channel!');
            } catch (err) {
                await safeReply(ctx, `❌ Failed to send: ${err.message}`);
            }
            ctx.session.step = null;
            ctx.session.draft = null;
        } else {
            const { date, assumedUtcDefault } = parseScheduleInput(text);
            if (!date || Number.isNaN(date.getTime()) || date <= new Date()) {
                return safeReply(
                    ctx,
                    '⚠️ Invalid date/time or it is in the past.\nUse `YYYY-MM-DD HH:MM` (UTC default), `YYYY-MM-DD HH:MM UTC`, `YYYY-MM-DD HH:MM -05:00`, or "now".',
                    { parse_mode: 'Markdown' }
                );
            }

            const job = {
                id: uuidv4(),
                date: date.toISOString(),
                messageId: ctx.session.draft.messageId,
                messageIds: ctx.session.draft.messageIds,
                fromChatId: ctx.session.draft.fromChatId,
                reply_markup: ctx.session.draft.reply_markup
            };

            try {
                saveJob(job);
            } catch (error) {
                console.error('Failed to save job:', error.message);
                return safeReply(ctx, '❌ Failed to save this job. Please try again.');
            }

            const scheduled = schedule.scheduleJob(job.id, date, () => executeJob(job));
            if (!scheduled) {
                deleteJobStmt.run(job.id);
                return safeReply(ctx, '❌ Failed to schedule this job. Please try again.');
            }

            const utcDefaultNote = assumedUtcDefault
                ? '\n(Interpreted as UTC because no timezone was provided.)'
                : '';
            await safeReply(
                ctx,
                `✅ Scheduled successfully for:\n${formatSchedulePreview(date)}${utcDefaultNote}\n\nJob ID: \`${job.id}\``,
                { parse_mode: 'Markdown' }
            );
            ctx.session.step = null;
            ctx.session.draft = null;
        }
    }
});

bot.catch(async (err, ctx) => {
    console.error('Unhandled bot error:', err);
    await notifyAdmin(`❌ Unhandled bot error: ${err.message}`);
    if (ctx && ctx.chat && ctx.chat.type === 'private' && ctx.from && ADMIN_ID_SET.has(ctx.from.id)) {
        await safeReply(ctx, '❌ Something went wrong while processing that update.');
    }
});

// Start the bot
bot.launch().then(() => {
    console.log('Bot is running...');
    loadJobs();
}).catch(err => {
    console.error('Failed to start bot:', err);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});
