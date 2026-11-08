// Modul: Join-to-create. Wer den Sprachkanal "Talk" betritt, bekommt eine eigene Kategorie
// mit einem Sprachkanal, beide nach ihm benannt, und wird dorthin verschoben.
// Ist der Raum 5 Minuten leer, wird die Kategorie samt Kanal gelöscht.
const { Events, ChannelType, PermissionsBitField, PermissionFlagsBits } = require('discord.js');

const HUB_NAME = 'Talk';
const EMPTY_MINUTES = 5;
const TICK_SECONDS = 10;
const WRITE = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.SendMessagesInThreads,
];

const timers = new Map(); // channelId -> Interval

const getRooms = (config, guildId) => config.getModule(guildId, 'tempVoice').settings.rooms || {};
const saveRooms = (config, guildId, rooms) => config.setModule(guildId, 'tempVoice', { settings: { rooms } });

function findHub(guild, config) {
  const id = config.getModule(guild.id, 'rulesRole').settings.voiceId;
  return (
    (id && guild.channels.cache.get(id)) ||
    guild.channels.cache.find((c) => c.type === ChannelType.GuildVoice && c.name === HUB_NAME)
  );
}

// Gleiche Sichtbarkeit wie der Raum, aber nur lesen: niemand darf schreiben (nur Roxie)
function readOnlyOverwrites(channel, botId) {
  const others = channel.permissionOverwrites.cache
    .filter((o) => o.id !== botId)
    .map((o) => ({
      id: o.id,
      type: o.type,
      allow: new PermissionsBitField(o.allow).remove(WRITE),
      deny: new PermissionsBitField(o.deny).add(WRITE),
    }));
  others.push({
    id: botId,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageChannels,
    ],
  });
  return others;
}

const fmt = (sec) => `# ⏳ ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

// Zeigt den Countdown: ein gesperrter Textkanal mit einer Nachricht, in der nur der große Timer steht.
// Der Kanal wird einmal angelegt, danach wird nur die Nachricht bearbeitet.
async function showCountdown(guild, config, channelId, seconds) {
  const rooms = getRooms(config, guild.id);
  const room = rooms[channelId];
  const channel = guild.channels.cache.get(channelId);
  if (!room || !channel) return;

  let countdown = room.countdownId && guild.channels.cache.get(room.countdownId);
  if (!countdown) {
    countdown = await guild.channels.create({
      name: 'timer',
      type: ChannelType.GuildText,
      parent: room.categoryId,
      reason: 'Roxie: Countdown bis der leere Raum gelöscht wird',
      permissionOverwrites: readOnlyOverwrites(channel, guild.client.user.id),
    });
    const msg = await countdown.send(fmt(seconds));
    const fresh = getRooms(config, guild.id);
    if (fresh[channelId]) {
      fresh[channelId].countdownId = countdown.id;
      fresh[channelId].messageId = msg.id;
      saveRooms(config, guild.id, fresh);
    }
    return;
  }

  const msg = room.messageId && (await countdown.messages.fetch(room.messageId).catch(() => null));
  if (msg) await msg.edit(fmt(seconds));
  else {
    const sent = await countdown.send(fmt(seconds));
    const fresh = getRooms(config, guild.id);
    if (fresh[channelId]) {
      fresh[channelId].messageId = sent.id;
      saveRooms(config, guild.id, fresh);
    }
  }
}

async function removeCountdown(guild, config, channelId) {
  const rooms = getRooms(config, guild.id);
  const room = rooms[channelId];
  if (!room?.countdownId) return;
  const ch = guild.channels.cache.get(room.countdownId);
  room.countdownId = null;
  room.messageId = null;
  saveRooms(config, guild.id, rooms);
  if (ch) await ch.delete('Roxie: Raum wieder belegt').catch(() => {});
}

function stopTimer(channelId) {
  clearInterval(timers.get(channelId));
  timers.delete(channelId);
}

async function cancelCountdown(guild, config, channelId) {
  stopTimer(channelId);
  await removeCountdown(guild, config, channelId);
}

async function deleteRoom(guild, config, channelId) {
  stopTimer(channelId);
  const rooms = getRooms(config, guild.id);
  const room = rooms[channelId];
  if (!room) return;
  delete rooms[channelId];
  saveRooms(config, guild.id, rooms);
  try {
    // Erst alle Kanäle der Kategorie (Raum + Countdown), dann die Kategorie selbst
    for (const ch of guild.channels.cache.filter((c) => c.parentId === room.categoryId).values()) {
      await ch.delete('Roxie: Talk-Raum war 5 Minuten leer');
    }
    const category = guild.channels.cache.get(room.categoryId);
    if (category) await category.delete('Roxie: Talk-Raum war 5 Minuten leer');
    console.log(`[tempVoice] Raum ${room.name} in ${guild.name} gelöscht`);
  } catch (err) {
    console.error('[tempVoice] Löschen fehlgeschlagen:', err.message);
  }
}

// Raum ist leer: Countdown von 5 Minuten starten, jede Minute aktualisieren, am Ende löschen
function startTimer(guild, config, channelId) {
  if (timers.has(channelId)) return;
  let remaining = EMPTY_MINUTES * 60;
  const log = (err) => console.error('[tempVoice] Countdown-Fehler:', err.message);

  showCountdown(guild, config, channelId, remaining).catch(log);
  timers.set(
    channelId,
    setInterval(() => {
      remaining -= TICK_SECONDS;
      if (remaining <= 0) deleteRoom(guild, config, channelId);
      else showCountdown(guild, config, channelId, remaining).catch(log);
    }, TICK_SECONDS * 1000),
  );
}

// Prüft einen Raum: gibt es ihn nicht mehr -> vergessen, ist er leer -> Countdown, sonst abbrechen
function checkRoom(guild, config, channelId) {
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return deleteRoom(guild, config, channelId);
  if (channel.members.size === 0) startTimer(guild, config, channelId);
  else if (timers.has(channelId)) return cancelCountdown(guild, config, channelId);
}

async function createRoom(member, hub, config) {
  const guild = member.guild;
  const rooms = getRooms(config, guild.id);

  // Hat der User schon einen Raum, dorthin verschieben statt einen zweiten anzulegen
  const existing = Object.entries(rooms).find(([id, r]) => r.ownerId === member.id && guild.channels.cache.has(id));
  if (existing) {
    await cancelCountdown(guild, config, existing[0]);
    return member.voice.setChannel(existing[0]);
  }

  const name = member.displayName.slice(0, 100);
  // Gleiche Sichtbarkeit wie der Talk-Kanal
  const permissionOverwrites = hub.permissionOverwrites.cache.map((o) => ({
    id: o.id,
    type: o.type,
    allow: o.allow,
    deny: o.deny,
  }));

  const category = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    reason: `Roxie: Talk-Raum für ${member.user.tag}`,
    permissionOverwrites,
  });
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    parent: category.id,
    reason: `Roxie: Talk-Raum für ${member.user.tag}`,
    permissionOverwrites,
  });

  // Textkanal zum einfachen Chatten (gleiche Rechte wie Talk: alle mit der Rolle dürfen schreiben)
  await guild.channels.create({
    name: 'chat',
    type: ChannelType.GuildText,
    parent: category.id,
    reason: `Roxie: Chat für Talk-Raum von ${member.user.tag}`,
    permissionOverwrites,
  });

  rooms[channel.id] = { categoryId: category.id, ownerId: member.id, name };
  saveRooms(config, guild.id, rooms);

  try {
    await member.voice.setChannel(channel);
  } catch {
    // User ist schon weg -> leerer Raum, Timer räumt ihn auf
  }
  checkRoom(guild, config, channel.id);
  console.log(`[tempVoice] Raum ${name} in ${guild.name} erstellt`);
}

module.exports = {
  id: 'tempVoice',
  name: 'Talk-Räume',
  description:
    'Wer den Sprachkanal „Talk“ betritt, bekommt eine eigene Kategorie mit Sprachkanal (nach ihm benannt) und Textkanal „chat“ und wird dorthin verschoben. Ist der Raum leer, erscheint ein gesperrter Kanal „timer“ mit einem großen Countdown (5 Minuten) und danach wird alles gelöscht.',
  settings: [],

  // Beim Start/Einschalten: übrig gebliebene Räume prüfen
  async setup(guild, config) {
    await guild.channels.fetch();
    for (const channelId of Object.keys(getRooms(config, guild.id))) {
      await removeCountdown(guild, config, channelId); // übrig gebliebener Countdown von vor dem Neustart
      await checkRoom(guild, config, channelId);
    }
  },

  register(client, config) {
    client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
      const guild = newState.guild;
      if (!config.getModule(guild.id, 'tempVoice').enabled) return;
      if (oldState.channelId === newState.channelId) return;

      try {
        const rooms = getRooms(config, guild.id);

        if (newState.channelId) {
          if (rooms[newState.channelId] && timers.has(newState.channelId)) await cancelCountdown(guild, config, newState.channelId);
          const hub = findHub(guild, config);
          if (hub && newState.channelId === hub.id && !newState.member.user.bot) {
            await createRoom(newState.member, hub, config);
          }
        }

        if (oldState.channelId && rooms[oldState.channelId]) await checkRoom(guild, config, oldState.channelId);
      } catch (err) {
        console.error('[tempVoice] Fehler:', err.message);
      }
    });
  },
};
