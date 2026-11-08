const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, Partials, ChannelType } = require('discord.js');
const config = require('./config');
const modules = require('./modules');

const TOKEN = process.env.DISCORD_TOKEN;
const PORT = Number(process.env.PORT) || 3000;

if (!TOKEN) {
  console.error('DISCORD_TOKEN fehlt.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.GuildMember],
});

for (const m of modules) m.register(client, config);

async function setupGuild(guild) {
  for (const m of modules) {
    if (m.setup && config.getModule(guild.id, m.id).enabled) await m.setup(guild, config);
  }
}

client.once('ready', async () => {
  console.log(`Roxie online als ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) await setupGuild(guild);
});
client.on('guildCreate', setupGuild);

// ---- Web-Oberfläche (bewusst ohne Login, nur lokal betreiben) ----
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/state', (req, res) => {
  res.json({
    bot: client.user ? { tag: client.user.tag, avatar: client.user.displayAvatarURL() } : null,
    modules: modules.map(({ id, name, description, settings, actions }) => ({ id, name, description, settings, actions: actions || [] })),
    guilds: client.guilds.cache.map((g) => ({
      id: g.id,
      name: g.name,
      roles: g.roles.cache
        .filter((r) => r.id !== g.id && !r.managed)
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name })),
      channels: g.channels.cache
        .filter((c) => [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory].includes(c.type))
        .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition)
        .map((c) => ({
          id: c.id,
          name: c.parent ? `${c.parent.name} / ${c.name}` : c.name,
          type: { [ChannelType.GuildText]: 'text', [ChannelType.GuildVoice]: 'voice', [ChannelType.GuildCategory]: 'category' }[c.type],
        })),
      modules: Object.fromEntries(modules.map((m) => [m.id, config.getModule(g.id, m.id)])),
    })),
  });
});

app.put('/api/guilds/:guildId/modules/:moduleId', async (req, res) => {
  const { guildId, moduleId } = req.params;
  if (!client.guilds.cache.has(guildId) || !modules.some((m) => m.id === moduleId)) {
    return res.status(404).json({ error: 'Server oder Modul unbekannt' });
  }
  const { enabled, settings } = req.body || {};
  // Gespeicherte Kanäle müssen auf dem Server existieren und vom passenden Typ sein
  const mod = modules.find((m) => m.id === moduleId);
  const guild = client.guilds.cache.get(guildId);
  for (const def of mod.settings || []) {
    const v = settings?.[def.key];
    if (!def.type.endsWith('Channel') || v === undefined || v === '') continue;
    const want = { textChannel: ChannelType.GuildText, voiceChannel: ChannelType.GuildVoice, categoryChannel: ChannelType.GuildCategory }[def.type];
    if (guild.channels.cache.get(v)?.type !== want) return res.status(400).json({ error: 'Ungültiger Kanal' });
  }
  config.setModule(guildId, moduleId, { enabled, settings });
  if (settings && mod.applySettings) await mod.applySettings(guild, config).catch((e) => console.error('[web]', e.message));
  if (enabled) await setupGuild(client.guilds.cache.get(guildId));
  res.json(config.getModule(guildId, moduleId));
});

app.post('/api/guilds/:guildId/modules/:moduleId/actions/:actionId', async (req, res) => {
  const { guildId, moduleId, actionId } = req.params;
  const guild = client.guilds.cache.get(guildId);
  const mod = modules.find((m) => m.id === moduleId);
  if (!guild || !mod?.runAction || !mod.actions?.some((a) => a.id === actionId)) {
    return res.status(404).json({ error: 'Server oder Aktion unbekannt' });
  }
  try {
    res.json(await mod.runAction(actionId, guild, config));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Web-Oberfläche auf Port ${PORT}`));
client.login(TOKEN);
