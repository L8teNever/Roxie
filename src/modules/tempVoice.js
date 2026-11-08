// Modul: Join-to-create. Wer den Sprachkanal "Talk" betritt, bekommt eine eigene Kategorie
// mit einem Sprachkanal, beide nach ihm benannt, und wird dorthin verschoben.
// Ist der Raum 5 Minuten leer, wird die Kategorie samt Kanal gelöscht.
const {
  Events,
  ChannelType,
  OverwriteType,
  PermissionsBitField,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
} = require('discord.js');

const HUB_NAME = 'Talk';
// Trennrolle in der Rollenliste: darunter stehen die Raum-Rollen
const DIVIDER_NAME = 'Raum:⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀';
const EMPTY_MINUTES = 5;
const TICK_SECONDS = 10;
const WRITE = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.SendMessagesInThreads,
];

const P = PermissionFlagsBits;
const ROOM_PERMS = [P.ViewChannel, P.Connect, P.Speak, P.SendMessages, P.ReadMessageHistory];
const OWNER_PERMS = [...ROOM_PERMS, P.ManageChannels, P.ManageMessages, P.MoveMembers, P.MuteMembers];

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
function toReadOnly(list, botId) {
  const others = list
    .filter((o) => o.id !== botId)
    .map((o) => ({
      id: o.id,
      type: o.type,
      allow: new PermissionsBitField(o.allow).remove(WRITE),
      deny: new PermissionsBitField(o.deny).add(WRITE),
    }));
  others.push({
    id: botId,
    type: OverwriteType.Member,
    allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels],
  });
  return others;
}

const readOnlyOverwrites = (channel, botId) =>
  toReadOnly(
    channel.permissionOverwrites.cache.map((o) => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny })),
    botId,
  );

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

async function deleteRoom(guild, config, channelId, reason = 'Roxie: Talk-Raum war 5 Minuten leer') {
  stopTimer(channelId);
  const rooms = getRooms(config, guild.id);
  const room = rooms[channelId];
  if (!room) return;
  delete rooms[channelId];
  saveRooms(config, guild.id, rooms);
  try {
    // Erst alle Kanäle der Kategorie (Raum + Countdown), dann die Kategorie selbst
    for (const ch of guild.channels.cache.filter((c) => c.parentId === room.categoryId).values()) {
      await ch.delete(reason);
    }
    const category = guild.channels.cache.get(room.categoryId);
    if (category) await category.delete(reason);
    const role = room.roleId && guild.roles.cache.get(room.roleId);
    if (role) await role.delete(reason);
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

// Rechte für Kategorie, Sprach- und Chatkanal des Raums.
// Öffentlich: zusätzlich die Rechte von Talk (alle mit der Rolle „Online“). Privat: nur Raum-Rolle (Besitzer + Ausgewählte).
function roomOverwrites(guild, hub, roleId, ownerId, isPublic) {
  const botId = guild.client.user.id;
  const list = [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
    { id: roleId, type: OverwriteType.Role, allow: ROOM_PERMS },
    { id: ownerId, type: OverwriteType.Member, allow: OWNER_PERMS },
    { id: botId, type: OverwriteType.Member, allow: [...ROOM_PERMS, P.ManageChannels] },
  ];
  if (isPublic && hub) {
    const taken = new Set(list.map((o) => o.id));
    for (const o of hub.permissionOverwrites.cache.values()) {
      if (!taken.has(o.id)) list.push({ id: o.id, type: o.type, allow: o.allow, deny: o.deny });
    }
  }
  return list;
}

function settingsPayload(room, channelId) {
  const toggle = new ButtonBuilder()
    .setCustomId(`room:toggle:${channelId}`)
    .setLabel(room.public ? 'Auf privat stellen' : 'Auf öffentlich stellen')
    .setEmoji(room.public ? '🔒' : '🌐')
    .setStyle(room.public ? ButtonStyle.Danger : ButtonStyle.Success);
  const addAll = new ButtonBuilder()
    .setCustomId(`room:addall:${channelId}`)
    .setLabel('Alle hinzufügen')
    .setEmoji('👥')
    .setStyle(ButtonStyle.Primary);
  const removeAll = new ButtonBuilder()
    .setCustomId(`room:removeall:${channelId}`)
    .setLabel('Alle entfernen')
    .setStyle(ButtonStyle.Secondary);
  const del = new ButtonBuilder()
    .setCustomId(`room:delete:${channelId}`)
    .setLabel('Raum löschen')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Danger);
  // Discord erlaubt pro Auswahl höchstens 25 User, darum je ein Menü zum Hinzufügen und zum Entfernen
  const add = new UserSelectMenuBuilder()
    .setCustomId(`room:add:${channelId}`)
    .setPlaceholder('User hinzufügen (bis zu 25 auf einmal)')
    .setMinValues(1)
    .setMaxValues(25);
  const remove = new UserSelectMenuBuilder()
    .setCustomId(`room:remove:${channelId}`)
    .setPlaceholder('User entfernen')
    .setMinValues(1)
    .setMaxValues(25);

  return {
    content:
      `# ⚙️ Einstellungen: ${room.name}\n` +
      (room.public
        ? '**Öffentlich:** Alle mit der Rolle „Online“ sehen deinen Raum und dürfen rein.'
        : '**Privat:** Nur du und die ausgewählten User sehen deinen Raum.') +
      `\n**Ausgewählte User:** ${room.allowed.length ? room.allowed.map((id) => `<@${id}>`).join(' ') : 'keine'}` +
      '\nDie Auswahl zählt, sobald der Raum privat ist. Der Raum wird gelöscht, wenn er 5 Minuten leer ist, oder sofort mit dem Button unten.',
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder().addComponents(toggle, addAll, removeAll, del),
      new ActionRowBuilder().addComponents(add),
      new ActionRowBuilder().addComponents(remove),
    ],
  };
}

// Wendet öffentlich/privat auf alle Kanäle des Raums an
async function applyMode(guild, config, channelId) {
  const room = getRooms(config, guild.id)[channelId];
  if (!room) return;
  const overwrites = roomOverwrites(guild, findHub(guild, config), room.roleId, room.ownerId, room.public);
  for (const id of [room.categoryId, channelId, room.chatId]) {
    const ch = guild.channels.cache.get(id);
    if (ch) await ch.permissionOverwrites.set(overwrites, 'Roxie: Raum-Einstellung geändert');
  }
  const countdown = room.countdownId && guild.channels.cache.get(room.countdownId);
  if (countdown) await countdown.permissionOverwrites.set(toReadOnly(overwrites, guild.client.user.id));
}

// Reaktion auf Button/Auswahl im Einstellungskanal (nur der Besitzer)
async function handleSettings(interaction, config) {
  const [, action, channelId] = interaction.customId.split(':');
  const guild = interaction.guild;
  const rooms = getRooms(config, guild.id);
  const room = rooms[channelId];
  if (!room) return interaction.reply({ content: 'Diesen Raum gibt es nicht mehr.', ephemeral: true });
  if (interaction.user.id !== room.ownerId) {
    return interaction.reply({ content: 'Nur der Besitzer des Raums darf das ändern.', ephemeral: true });
  }

  if (action === 'delete') {
    await interaction.deferUpdate();
    return deleteRoom(guild, config, channelId, 'Roxie: Raum vom Besitzer gelöscht');
  }

  if (action === 'toggle') {
    room.public = !room.public;
    saveRooms(config, guild.id, rooms);
    await interaction.deferUpdate();
    await applyMode(guild, config, channelId);
    return interaction.message.edit(settingsPayload(room, channelId));
  }

  if (['add', 'users', 'remove', 'addall', 'removeall'].includes(action)) {
    await interaction.deferUpdate();
    const role = guild.roles.cache.get(room.roleId);
    let toAdd = [];
    let toRemove = [];

    if (action === 'add' || action === 'users') toAdd = interaction.values;
    else if (action === 'remove') toRemove = interaction.values;
    else if (action === 'removeall') toRemove = [...room.allowed];
    else {
      const members = await guild.members.fetch();
      toAdd = members.filter((m) => !m.user.bot).map((m) => m.id);
    }

    toAdd = toAdd.filter((id) => id !== room.ownerId);
    toRemove = toRemove.filter((id) => id !== room.ownerId);
    for (const id of toAdd) {
      const m = await guild.members.fetch(id).catch(() => null);
      if (m && role && !m.roles.cache.has(role.id)) await m.roles.add(role, 'Roxie: Zugang zum Talk-Raum').catch(() => {});
    }
    for (const id of toRemove) {
      const m = await guild.members.fetch(id).catch(() => null);
      if (m && role) await m.roles.remove(role, 'Roxie: Zugang zum Talk-Raum entzogen').catch(() => {});
    }
    room.allowed = [...new Set([...room.allowed, ...toAdd])].filter((id) => !toRemove.includes(id));
    saveRooms(config, guild.id, rooms);
    return interaction.message.edit(settingsPayload(room, channelId));
  }
}

// Trennrolle "Raum:" (gibt es nur einmal pro Server). Die Raum-Rollen werden direkt darunter einsortiert.
async function ensureDivider(guild, config) {
  await guild.roles.fetch();
  const savedId = config.getModule(guild.id, 'tempVoice').settings.dividerId;
  let divider =
    (savedId && guild.roles.cache.get(savedId)) ||
    guild.roles.cache.find((r) => r.name === DIVIDER_NAME && !r.managed);
  if (!divider) {
    divider = await guild.roles.create({
      name: DIVIDER_NAME,
      permissions: [],
      reason: 'Roxie: Trennrolle für Talk-Raum-Rollen',
    });
    console.log(`[tempVoice] Trennrolle in ${guild.name} erstellt`);
  }
  if (savedId !== divider.id) config.setModule(guild.id, 'tempVoice', { settings: { dividerId: divider.id } });
  return divider;
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

  // Eigene Rolle für diesen Raum: gibt es nur, solange es die Kategorie gibt
  const divider = await ensureDivider(guild, config);
  const role = await guild.roles.create({
    name, // nur der Name des Raums
    permissions: [],
    reason: `Roxie: Raum-Rolle für ${member.user.tag}`,
  });
  // Direkt unter die Trennrolle "Raum:" sortieren
  await role.setPosition(divider.position, { reason: 'Roxie: unter die Trennrolle' }).catch((err) => {
    console.error('[tempVoice] Rolle konnte nicht unter die Trennrolle:', err.message);
  });
  await member.roles.add(role, 'Roxie: Besitzer des Talk-Raums');

  const permissionOverwrites = roomOverwrites(guild, hub, role.id, member.id, true);
  const reason = `Roxie: Talk-Raum für ${member.user.tag}`;

  const category = await guild.channels.create({ name, type: ChannelType.GuildCategory, reason, permissionOverwrites });
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    parent: category.id,
    reason,
    permissionOverwrites,
  });
  // Textkanal zum einfachen Chatten (am Anfang dürfen alle mit der Rolle „Online“ schreiben)
  const chat = await guild.channels.create({
    name: 'chat',
    type: ChannelType.GuildText,
    parent: category.id,
    reason,
    permissionOverwrites,
  });
  // Einstellungen: nur der Besitzer sieht den Kanal
  const settings = await guild.channels.create({
    name: 'einstellungen',
    type: ChannelType.GuildText,
    parent: category.id,
    reason,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
      { id: member.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages] },
      { id: guild.client.user.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels] },
    ],
  });

  const room = {
    categoryId: category.id,
    ownerId: member.id,
    name,
    roleId: role.id,
    chatId: chat.id,
    settingsId: settings.id,
    public: true,
    allowed: [],
  };
  const msg = await settings.send(settingsPayload(room, channel.id));
  room.settingsMessageId = msg.id;
  rooms[channel.id] = room;
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
    'Wer den Sprachkanal „Talk“ betritt, bekommt eine eigene Kategorie mit Sprachkanal (nach ihm benannt), Textkanal „chat“ und einem Einstellungskanal (nur für ihn: öffentlich/privat, wer rein darf) und wird dorthin verschoben. Er bekommt dafür eine eigene Raum-Rolle (nur der Raumname, einsortiert unter der Trennrolle „Raum:“) und Verwaltungsrechte für die Kategorie. Ist der Raum leer, erscheint ein gesperrter Kanal „timer“ mit einem großen Countdown (5 Minuten) und danach wird alles gelöscht.',
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
    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.guild || !(interaction.isButton() || interaction.isUserSelectMenu())) return;
      if (!interaction.customId.startsWith('room:')) return;
      if (!config.getModule(interaction.guild.id, 'tempVoice').enabled) return;
      try {
        await handleSettings(interaction, config);
      } catch (err) {
        console.error('[tempVoice] Einstellungen:', err.message);
      }
    });

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
