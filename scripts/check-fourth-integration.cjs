const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');

// Exercise the actual storage functions without loading browser-only databases.
function functions(file, names) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ts.ScriptTarget.Latest, true);
  return source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    .map(node => node.getText(source).replace(/^export\s+/, '')).join('\n');
}
let sessions = [];
let account = 'alt-a';
const context = {
  Date, Math, Map, Set,
  loadChatSessions: () => sessions,
  saveChatSessions: value => { sessions = value; },
  loadChatScope: () => ({ chatAccountId: account }),
  getLastVisibleSessionMessage: () => null,
  DEFAULT_SESSION_CONTEXT_TOKEN_BUDGET: 16000,
  DEFAULT_VISION_IMAGE_PROMPT_LIMIT: 10,
};
vm.createContext(context);
const code = functions('lib/chat-storage.ts', ['isExplicitlySeparateSession', 'normalizeChatSessions', 'parseIsoTime', 'getSessionActivityTime', 'isPreferredSession', 'normalizeContextTokenBudget', 'createChatSession', 'createOrGetSession', 'getSessionsForContact'])
  + '\n' + functions('lib/chat-session-merge.ts', ['duplicateKey']);
vm.runInContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022 }), context);
const make = (id, extras = {}) => ({ id, contactId: 'alice', updatedAt: '2026-10-20T01:00:00Z', ...extras });
const main = make('main');
const alt = make('alt', { chatAccountId: 'alt-a' });
const thread = make('thread', { chatAccountId: 'alt-a', title: 'Independent thread' });
const child = make('child', { chatAccountId: 'alt-a', parentSessionId: 'alt' });
const newer = make('newer', { chatAccountId: 'alt-a', updatedAt: '2026-10-20T02:00:00Z' });

const normalized = context.normalizeChatSessions([main, alt, thread, child, newer]);
assert.equal(normalized.items.length, 4, 'independent threads and accounts survive normalization');
assert.equal(normalized.redirects.get('alt'), 'newer', 'only duplicate sessions within one account merge');
assert.equal(normalized.redirects.has('main'), false);
assert.equal(context.duplicateKey(thread), null, 'manual merge prompt excludes independent threads');
assert.equal(context.duplicateKey(child), null);
assert.notEqual(context.duplicateKey(main), context.duplicateKey(alt));

sessions = [thread, main, alt];
assert.equal(context.createOrGetSession('alice').id, 'alt', 'contact entry opens the base session in the active account');
assert.equal(context.createOrGetSession('alice', null).id, 'main');
assert.equal(context.getSessionsForContact('alice').length, 2);
assert.equal(context.getSessionsForContact('alice', null).length, 1);
const created = context.createChatSession('alice', { title: 'New window' });
assert.equal(created.chatAccountId, 'alt-a');
account = 'alt-b';
const continued = context.createChatSession('alice', { title: 'Continued', chatAccountId: 'alt-a', parentSessionId: 'alt' });
assert.equal(continued.chatAccountId, 'alt-a', 'embedded session keeps its original account after a global switch');
const explicitMain = context.createChatSession('alice', { title: 'Main window', chatAccountId: null });
assert.equal(explicitMain.chatAccountId, undefined);
assert.ok(context.normalizeChatSessions(sessions).items.some(s => s.id === continued.id));

const assets = vm.createContext({ readAssetRecords: async ids => {
  assert.deepEqual(Array.from(ids), ['asset-1'], 'direct URLs never enter IndexedDB');
  return [{ id: 'asset-1', dataUrl: 'data:image/png;base64,saved' }];
} });
vm.runInContext(ts.transpile(functions('lib/theme-storage.ts', ['getThemeAssetMap']), { target: ts.ScriptTarget.ES2022 }), assets);
(async () => {
  const result = await assets.getThemeAssetMap(['asset-1', 'asset-1', 'https://example.com/icon.png', 'data:image/png;base64,direct', 'blob:preview', '']);
  assert.equal(result['asset-1'], 'data:image/png;base64,saved');
  assert.equal(result['https://example.com/icon.png'], 'https://example.com/icon.png');
  assert.equal(result['data:image/png;base64,direct'], 'data:image/png;base64,direct');
  assert.equal(result['blob:preview'], 'blob:preview');
  console.log('Fourth-edition integration checks passed: account isolation, independent threads, default sessions, theme assets.');
})().catch(error => { console.error(error); process.exitCode = 1; });
