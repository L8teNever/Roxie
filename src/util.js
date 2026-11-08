const { ChannelType } = require('discord.js');

// Hält die auf der Website gewählte Kategorie (z. B. "Admin") immer ganz unten,
// also unter allen anderen Kategorien (auch unter neuen Talk-Raum-Kategorien).
async function keepBottom(guild, config) {
  const id = config.getModule(guild.id, 'tempVoice').settings.bottomCategoryId;
  if (!id) return;
  try {
    const channels = await guild.channels.fetch();
    const bottom = channels.get(id);
    if (!bottom || bottom.type !== ChannelType.GuildCategory) return;
    const others = channels.filter((c) => c.type === ChannelType.GuildCategory && c.id !== id);
    if (!others.size) return;
    const max = Math.max(...others.map((c) => c.rawPosition));
    if (bottom.rawPosition > max) return;
    await guild.channels.setPositions([{ channel: bottom.id, position: max + 1 }]);
  } catch (err) {
    console.error('[util] Kategorie nach unten schieben fehlgeschlagen:', err.message);
  }
}

// Discord macht Textkanal-Namen klein und ersetzt Leerzeichen durch Bindestriche
const textName = (s) => s.toLowerCase().trim().replace(/\s+/g, '-');

module.exports = { keepBottom, textName };
