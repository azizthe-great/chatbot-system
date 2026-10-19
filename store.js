const fs = require('node:fs');
const path = require('node:path');
const file = process.env.PORTSIDE_DATA_FILE || path.join(__dirname, 'data', 'portside.json');
const empty = () => ({ accounts: [], queries: [], unresolved: [], knowledge: [], models: {}, conversations: [], quotes: [] });
let state = empty();
if (file !== ':memory:' && fs.existsSync(file)) state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
function save() {
  if (file === ':memory:') return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
module.exports = { state, save };
