const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
test('accounts, knowledge and saved estimates survive a process restart without storing plaintext passwords', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portside-test-')), file = join(dir, 'store.json');
  const env = { ...process.env, PORTSIDE_DATA_FILE: file };
  try {
    execFileSync(process.execPath, ['-e', "const auth=require('./auth'); const {state,save}=require('./store'); auth.register({username:'durable',name:'Durable',password:'PersistentPassword123!'}); state.quotes.push({id:'saved',username:'durable',result:{total:123}}); state.knowledge.push({id:'answer',question:'Q',answer:'A'});save();"], { env });
    const result = JSON.parse(execFileSync(process.execPath, ['-e', "const auth=require('./auth'); const {state}=require('./store'); process.stdout.write(JSON.stringify({user:auth.authenticate('durable','PersistentPassword123!'),quote:state.quotes[0],knowledge:state.knowledge[0]}));"], { env, encoding: 'utf8' }));
    assert.equal(result.user.username, 'durable'); assert.equal(result.quote.result.total, 123); assert.equal(result.knowledge.answer, 'A'); assert.ok(!readFileSync(file, 'utf8').includes('PersistentPassword123!'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
