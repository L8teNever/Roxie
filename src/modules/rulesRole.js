// Modul: Gibt neuen Usern die Rolle "Online", sobald sie die Server-Regeln akzeptiert haben
// (Discords "Regeln bestätigen" beim Beitritt, Member Screening).
// Die Rolle wird automatisch angelegt und in der Mitgliederliste separat gruppiert angezeigt.
const { Events, ChannelType, PermissionFlagsBits: P } = require('discord.js');

const ROLE_NAME = 'Online';
const CHANNEL_NAME = 'allgemein';
const CATEGORY_NAME = 'Allgemein';
const VOICE_NAME = 'Talk';

async function ensureRole(guild, config) {
  const mod = config.getModule(guild.id, 'rulesRole');
  await guild.roles.fetch();

  let role =
    (mod.settings.roleId && guild.roles.cache.get(mod.settings.roleId)) ||
    guild.roles.cache.find((r) => r.name === ROLE_NAME && !r.managed);

  if (!role) {
    role = await guild.roles.create({
      name: ROLE_NAME,
      hoist: true,
      reason: 'Roxie: Rolle für Mitglieder, die die Regeln akzeptiert haben',
    });
    console.log(`[rulesRole] Rolle "${ROLE_NAME}" in ${guild.name} erstellt`);
  } else if (!role.hoist) {
    // In der Mitgliederliste separat anzeigen
    await role.setHoist(true, 'Roxie: Mitglieder gruppiert anzeigen');
  }

  if (mod.settings.roleId !== role.id) config.setModule(guild.id, 'rulesRole', { settings: { roleId: role.id } });
  return role;
}

// Legt den Kanal "allgemein" an, den nur Leute mit der Rolle sehen. Ein vorhandener Kanal wird nicht angefasst.
async function ensureChannel(guild, role, client, config) {
  const mod = config.getModule(guild.id, 'rulesRole');
  const channels = await guild.channels.fetch();
  const existing =
    (mod.settings.channelId && channels.get(mod.settings.channelId)) ||
    channels.find((c) => c.type === ChannelType.GuildText && c.name === CHANNEL_NAME);
  if (existing) {
    if (mod.settings.channelId !== existing.id) config.setModule(guild.id, 'rulesRole', { settings: { channelId: existing.id } });
    return existing;
  }

  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
    { id: role.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.Connect, P.Speak] },
    // Der Bot selbst darf immer alles sehen
    { id: client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels] },
  ];

  // Passende Kategorie (nur wenn der Kanal neu angelegt wird)
  const category =
    (mod.settings.categoryId && channels.get(mod.settings.categoryId)) ||
    channels.find((c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME) ||
    (await guild.channels.create({
      name: CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      reason: 'Roxie: Kategorie für Mitglieder, die die Regeln akzeptiert haben',
      permissionOverwrites,
    }));

  const channel = await guild.channels.create({
    name: CHANNEL_NAME,
    type: ChannelType.GuildText,
    parent: category.id,
    reason: 'Roxie: Kanal nur für Mitglieder, die die Regeln akzeptiert haben',
    permissionOverwrites,
  });

  // Sprachkanal in derselben Kategorie (nur wenn es noch keinen gleichnamigen gibt)
  if (!channels.some((c) => c.type === ChannelType.GuildVoice && c.name === VOICE_NAME)) {
    const voice = await guild.channels.create({
      name: VOICE_NAME,
      type: ChannelType.GuildVoice,
      parent: category.id,
      reason: 'Roxie: Sprachkanal für Mitglieder, die die Regeln akzeptiert haben',
      permissionOverwrites,
    });
    config.setModule(guild.id, 'rulesRole', { settings: { voiceId: voice.id } });
  }
  config.setModule(guild.id, 'rulesRole', { settings: { channelId: channel.id, categoryId: category.id } });
  console.log(`[rulesRole] Kanal #${CHANNEL_NAME} in ${guild.name} erstellt`);
  return channel;
}

module.exports = {
  id: 'rulesRole',
  name: 'Regeln akzeptiert',
  description:
    'Wenn ein neuer User die Server-Regeln akzeptiert hat, bekommt er automatisch die Rolle „Online“ (wird von Roxie angelegt und in der Mitgliederliste gruppiert angezeigt). Dazu legt Roxie die Kategorie „Allgemein“ mit dem Textkanal „allgemein“ und dem Sprachkanal „Talk“ an, die nur diese Rolle sieht.',
  settings: [],
  actions: [{ id: 'giveAll', label: 'Allen aktuellen Mitgliedern die Rolle geben' }],

  // Gibt die Rolle allen, die sie noch nicht haben (ohne Bots und ohne User, die die Regeln noch nicht akzeptiert haben)
  async runAction(actionId, guild, config) {
    if (actionId !== 'giveAll') throw new Error('Unbekannte Aktion');
    const role = await ensureRole(guild, config);
    await ensureChannel(guild, role, guild.client, config);
    const members = await guild.members.fetch();
    let given = 0;
    let failed = 0;
    for (const member of members.values()) {
      if (member.user.bot || member.pending || member.roles.cache.has(role.id)) continue;
      try {
        await member.roles.add(role, 'Roxie: Rolle für alle bestehenden Mitglieder');
        given++;
      } catch {
        failed++;
      }
    }
    return { given, failed };
  },

  // Wird beim Start, beim Server-Beitritt und beim Einschalten aufgerufen
  async setup(guild, config) {
    try {
      const role = await ensureRole(guild, config);
      await ensureChannel(guild, role, guild.client, config);
    } catch (err) {
      console.error(`[rulesRole] Rolle in ${guild.name} nicht möglich:`, err.message);
    }
  },

  register(client, config) {
    client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
      // Nur der Wechsel pending -> nicht mehr pending zählt (Regeln akzeptiert).
      if (newMember.pending || oldMember.pending === false) return;

      const guild = newMember.guild;
      const mod = config.getModule(guild.id, 'rulesRole');
      if (!mod.enabled) return;

      try {
        const role = await ensureRole(guild, config);
        if (newMember.roles.cache.has(role.id)) return;
        await newMember.roles.add(role, 'Roxie: Regeln akzeptiert');
        console.log(`[rulesRole] ${newMember.user.tag} in ${guild.name} Rolle gegeben`);
      } catch (err) {
        console.error('[rulesRole] Fehler:', err.message);
      }
    });
  },
};
