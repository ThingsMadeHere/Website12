// ── Discord bot relay service ────────────────────────────────────────────────
// Full bot client for accessing all channels in a server
// Uses discord.js with MESSAGE_CONTENT intent to read all messages

const { Client, GatewayIntentBits, Partials, ChannelType } = require('discord.js');
const sqlite3 = require('better-sqlite3');
const path = require('path');

// Load environment
require('dotenv').config({ path: path.join(__dirname, '.env') });

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_SERVER_ID = process.env.DISCORD_SERVER_ID;

// Database for message history
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data/mchs.db');

// State
let socketIO = null;
let client = null;
let channels = new Map(); // channel_id -> channel info
let messageQueue = [];

// ── initialize ───────────────────────────────────────────────────────────────
// Set up Socket.IO for broadcasting messages and start Discord bot
function initialize(io) {
  socketIO = io;
  
  if (!DISCORD_BOT_TOKEN) {
    console.warn('[Discord] Missing DISCORD_BOT_TOKEN - bot disabled');
    return null;
  }

  // Create Discord client with full access
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  client.on('ready', async () => {
    console.log(`[Discord] Bot logged in as ${client.user.tag}`);
    
    // Load channels
    await loadChannels();
  });

  client.on('messageCreate', handleDiscordMessage);
  client.on('channelCreate', loadChannels);
  client.on('channelDelete', loadChannels);
  client.on('channelUpdate', loadChannels);

  // Login
  client.login(DISCORD_BOT_TOKEN).catch(err => {
    console.error('[Discord] Login failed:', err.message);
  });

  return client;
}

// ── loadChannels ─────────────────────────────────────────────────────────────
// Fetch all accessible channels from the server
async function loadChannels() {
  if (!client || !client.guilds) return;

  channels.clear();

  for (const guild of client.guilds.cache.values()) {
    // If DISCORD_SERVER_ID is set, only load from that server
    if (DISCORD_SERVER_ID && guild.id !== DISCORD_SERVER_ID) continue;

    for (const [id, channel] of guild.channels.cache) {
      if (channel.type === ChannelType.GuildText) {
        channels.set(id, {
          id: channel.id,
          name: channel.name,
          topic: channel.topic || '',
          guildName: guild.name,
        });
      }
    }
  }

  console.log(`[Discord] Loaded ${channels.size} text channels`);
}

// ── getChannels ──────────────────────────────────────────────────────────────
// Get list of channels
function getChannels() {
  return Array.from(channels.values());
}

// ── handleDiscordMessage ─────────────────────────────────────────────────────
// Process incoming Discord messages and broadcast to website
function handleDiscordMessage(message) {
  // Ignore bot messages
  if (message.author.bot) return;

  // Ignore DMs (only show server channels)
  if (!message.guild) return;

  // Build message object
  const msg = {
    id: message.id,
    type: 'discord',
    userId: message.author.id,
    username: message.author.username,
    avatar: message.author.displayAvatarURL(),
    body: message.content,
    ts: message.createdTimestamp,
    channel: message.channel.name,
    channelId: message.channel.id,
    guildName: message.guild.name,
  };

  // Save to database
  saveMessageToDb(msg);

  // Broadcast via Socket.IO
  if (socketIO) {
    socketIO.emit('chat:message', msg);
    console.log(`[Discord→Website] ${msg.channel}/${msg.username}: ${msg.body.substring(0, 50)}...`);
  }
}

// ── sendToDiscord ────────────────────────────────────────────────────────────
// Send a message to a specific Discord channel
function sendToDiscord({ channelId, body, username, avatar, userId }) {
  if (!client) {
    console.warn('[Discord] Bot not initialized');
    return false;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.warn(`[Discord] Channel ${channelId} not found`);
    return false;
  }

  // Send message
  channel.send(body.substring(0, 2000)) // Discord limit
    .then((sentMessage) => {
      console.log(`[Website→Discord] Sent to #${channel.name}: ${body.substring(0, 50)}...`);
      
      // Save to DB
      const msg = {
        id: sentMessage.id,
        type: 'website',
        userId: userId || 'anonymous',
        username: username || 'Anonymous',
        avatar: avatar || null,
        body: body,
        ts: sentMessage.createdTimestamp,
        channel: channel.name,
        channelId: channel.id,
      };
      saveMessageToDb(msg);

      // Broadcast to website
      if (socketIO) {
        socketIO.emit('chat:message', msg);
      }
    })
    .catch(err => {
      console.error('[Website→Discord] Error:', err.message);
    });

  return true;
}

// ── saveMessageToDb ──────────────────────────────────────────────────────────
// Save message to SQLite for history
function saveMessageToDb(msg) {
  try {
    const db = sqlite3(DB_PATH);
    db.prepare(`
      CREATE TABLE IF NOT EXISTS discord_messages (
        id TEXT PRIMARY KEY,
        type TEXT,
        user_id TEXT,
        username TEXT,
        avatar TEXT,
        body TEXT,
        ts INTEGER,
        channel TEXT,
        channel_id TEXT,
        guild_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    
    db.prepare(`
      INSERT OR REPLACE INTO discord_messages 
      (id, type, user_id, username, avatar, body, ts, channel, channel_id, guild_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msg.id,
      msg.type,
      msg.userId,
      msg.username,
      msg.avatar || '',
      msg.body,
      msg.ts,
      msg.channel,
      msg.channelId || '',
      msg.guildName || ''
    );
    
    db.close();
  } catch (err) {
    console.error('[Discord] DB save failed:', err.message);
  }
}

// ── getMessagesFromDb ───────────────────────────────────────────────────────
// Get recent messages from history
function getMessagesFromDb(channelId = null, limit = 50) {
  try {
    const db = sqlite3(DB_PATH);
    let sql;
    let params;
    
    if (channelId) {
      sql = `
        SELECT * FROM discord_messages 
        WHERE channel_id = ?
        ORDER BY ts DESC 
        LIMIT ?
      `;
      params = [channelId, limit];
    } else {
      sql = `
        SELECT * FROM discord_messages 
        ORDER BY ts DESC 
        LIMIT ?
      `;
      params = [limit];
    }
    
    const messages = db.prepare(sql).all(...params);
    db.close();
    
    // Reverse to show oldest first
    return messages.reverse();
  } catch (err) {
    console.error('[Discord] DB read failed:', err.message);
    return [];
  }
}

// ── export ───────────────────────────────────────────────────────────────────
module.exports = {
  initialize,
  getChannels,
  sendToDiscord,
  getMessagesFromDb,
};
