require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const LocalSession = require('telegraf-session-local');
const schedule = require('node-schedule');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const CHANNEL_ID = process.env.CHANNEL_ID;

const JOBS_FILE = './jobs.json';

// Ensure jobs file exists
if (!fs.existsSync(JOBS_FILE)) {
    fs.writeFileSync(JOBS_FILE, JSON.stringify([]));
}

// Session middleware for conversation state
const localSession = new LocalSession({ database: 'sessions.json' });
bot.use(localSession.middleware());

// Restrict to admin
bot.use((ctx, next) => {
    if (ctx.from && ctx.from.id === ADMIN_ID) {
        return next();
    } else if (ctx.chat && ctx.chat.type === 'private') {
        ctx.reply('⛔ Unauthorized. You are not the admin.');
    }
});

const getJobs = () => JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
const saveJobs = (jobs) => fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));

const executeJob = async (job) => {
    try {
        await bot.telegram.copyMessage(CHANNEL_ID, job.fromChatId, job.messageId, {
            reply_markup: job.reply_markup
        });
        bot.telegram.sendMessage(ADMIN_ID, `✅ Scheduled announcement executed successfully!`);
        console.log(`Job ${job.id} executed successfully.`);
    } catch (error) {
        bot.telegram.sendMessage(ADMIN_ID, `❌ Failed to execute scheduled announcement:\n${error.message}`);
        console.error(`Job ${job.id} failed:`, error.message);
    } finally {
        // Remove from db after execution
        let jobs = getJobs();
        jobs = jobs.filter(j => j.id !== job.id);
        saveJobs(jobs);
    }
};

const loadJobs = () => {
    let jobs = getJobs();
    let loadedCount = 0;
    const now = new Date();
    
    // Filter out jobs that are in the past
    const validJobs = jobs.filter(job => new Date(job.date) > now);
    saveJobs(validJobs);
    
    validJobs.forEach(job => {
        schedule.scheduleJob(job.id, new Date(job.date), () => executeJob(job));
        loadedCount++;
    });
    console.log(`Loaded ${loadedCount} scheduled jobs.`);
};

bot.command('start', (ctx) => {
    ctx.session.step = null;
    ctx.reply('👋 Welcome to the Announcement Bot.\n\nCommands:\n/new - Create a new announcement\n/jobs - View scheduled jobs\n/cancel - Cancel current operation');
});

bot.command('cancel', (ctx) => {
    ctx.session.step = null;
    ctx.session.draft = null;
    ctx.reply('❌ Cancelled current operation.');
});

bot.command('new', (ctx) => {
    ctx.session.step = 'awaiting_message';
    ctx.session.draft = {};
    ctx.reply('1️⃣ Send me the message, photo, video, or document you want to announce.\n*(Formatting and media will be preserved exactly as you send it.)*', { parse_mode: 'Markdown' });
});

bot.command('jobs', (ctx) => {
    const jobs = getJobs();
    const pending = jobs.filter(j => new Date(j.date) > new Date());
    
    if (pending.length === 0) return ctx.reply('📭 No scheduled announcements.');
    
    let msg = '📅 *Scheduled Announcements:*\n\n';
    pending.forEach((j, i) => {
        msg += `${i+1}. ${new Date(j.date).toUTCString()}\nID: \`${j.id}\`\n\n`;
    });
    msg += 'To delete a job, use `/deljob <ID>`';
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('deljob', (ctx) => {
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) return ctx.reply('⚠️ Provide an ID: `/deljob <ID>`');
    
    const id = parts[1];
    let jobs = getJobs();
    const initialLength = jobs.length;
    jobs = jobs.filter(j => j.id !== id);
    
    if (jobs.length < initialLength) {
        saveJobs(jobs);
        schedule.cancelJob(id);
        ctx.reply(`✅ Job \`${id}\` cancelled and deleted.`, { parse_mode: 'Markdown' });
    } else {
        ctx.reply('❌ Job ID not found.');
    }
});

bot.on('message', async (ctx) => {
    if (ctx.message.text && ctx.message.text.startsWith('/')) return; // Ignore unhandled commands

    const step = ctx.session.step;

    if (step === 'awaiting_message') {
        ctx.session.draft.messageId = ctx.message.message_id;
        ctx.session.draft.fromChatId = ctx.chat.id;
        
        ctx.session.step = 'awaiting_buttons';
        ctx.reply('2️⃣ Message saved!\n\nNow, send me the inline buttons formatted like:\n`Button Text | https://link.com`\n*(One per line)*\n\nOr simply reply with "none" to skip buttons.', { parse_mode: 'Markdown' });
    }
    else if (step === 'awaiting_buttons') {
        const text = ctx.message.text || '';
        let reply_markup = undefined;
        
        if (text.toLowerCase() !== 'none') {
            const buttons = [];
            const lines = text.split('\n');
            for (let line of lines) {
                const parts = line.split('|').map(s => s.trim());
                if (parts.length >= 2) {
                    const btnText = parts[0];
                    const url = parts.slice(1).join('|'); // In case URL contains |
                    if (url.startsWith('http')) {
                        buttons.push([Markup.button.url(btnText, url)]);
                    }
                }
            }
            if (buttons.length > 0) {
                reply_markup = { inline_keyboard: buttons };
                ctx.reply(`✅ Added ${buttons.length} buttons.`);
            } else {
                return ctx.reply('⚠️ Invalid format. Try again or type "none".');
            }
        } else {
            ctx.reply('⏭️ Skipped buttons.');
        }
        
        ctx.session.draft.reply_markup = reply_markup;
        ctx.session.step = 'awaiting_schedule';
        
        ctx.reply('3️⃣ Almost done! When should I post this?\n\n- Type "now" to post immediately.\n- Or send a date/time like `YYYY-MM-DD HH:MM` (e.g., `2024-12-01 15:30` in UTC).');
    }
    else if (step === 'awaiting_schedule') {
        const text = (ctx.message.text || '').trim();
        
        if (text.toLowerCase() === 'now') {
            try {
                await ctx.telegram.copyMessage(CHANNEL_ID, ctx.session.draft.fromChatId, ctx.session.draft.messageId, {
                    reply_markup: ctx.session.draft.reply_markup
                });
                ctx.reply('✅ Sent immediately to the channel!');
            } catch (err) {
                ctx.reply(`❌ Failed to send: ${err.message}`);
            }
            ctx.session.step = null;
        } else {
            const date = new Date(text);
            if (isNaN(date.getTime()) || date < new Date()) {
                return ctx.reply('⚠️ Invalid date/time or it is in the past. Try again (YYYY-MM-DD HH:MM) or "now".');
            }
            
            const job = {
                id: uuidv4(),
                date: date.toISOString(),
                messageId: ctx.session.draft.messageId,
                fromChatId: ctx.session.draft.fromChatId,
                reply_markup: ctx.session.draft.reply_markup
            };
            
            let jobs = getJobs();
            jobs.push(job);
            saveJobs(jobs);
            
            schedule.scheduleJob(job.id, date, () => executeJob(job));
            
            ctx.reply(`✅ Scheduled successfully for:\n**${date.toUTCString()}**\n\nJob ID: \`${job.id}\``, { parse_mode: 'Markdown' });
            ctx.session.step = null;
        }
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
