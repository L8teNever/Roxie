const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'config.json');

let data = { guilds: {} };

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!data.guilds) data.guilds = {};
  } catch {
    data = { guilds: {} };
  }
}

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function getModule(guildId, moduleId) {
  return data.guilds[guildId]?.modules?.[moduleId] || { enabled: false, settings: {} };
}

function setModule(guildId, moduleId, { enabled, settings }) {
  const g = (data.guilds[guildId] ||= { modules: {} });
  const m = (g.modules[moduleId] ||= { enabled: false, settings: {} });
  if (typeof enabled === 'boolean') m.enabled = enabled;
  if (settings && typeof settings === 'object') m.settings = { ...m.settings, ...settings };
  save();
  return m;
}

load();
module.exports = { getModule, setModule };
