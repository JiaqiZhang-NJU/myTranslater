import test from 'node:test';
import assert from 'node:assert/strict';
import { currentBudget, parseBudgetSettings, validateBudgetSettings } from '../src/budget.ts';
import { PageCache } from '../src/content/cache.ts';
import { providerIdentity } from '../src/settings.ts';
import { pageUrlIdentity } from '../src/shared.ts';

test('budget defaults, positive safe integer validation and configuration changes preserve reservations', () => {
  assert.deepEqual(parseBudgetSettings(undefined), { deepseek: { enabled: true, limit: 30000 }, ollama: { enabled: true, limit: 30000 } });
  for (const limit of [0, -1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateBudgetSettings({ deepseek: { enabled: true, limit }, ollama: { enabled: false, limit: 1000 } }));
  }
  const prior = { documentId: 'doc', used: 9000, inFlight: 2000, limit: 60000, configuredLimit: 30000, enabled: true };
  assert.equal(currentBudget(prior, 'doc', { enabled: true, limit: 30000 }).limit, 60000);
  assert.deepEqual(currentBudget(prior, 'doc', { enabled: false, limit: 10000 }), { ...prior, enabled: false, limit: 10000, configuredLimit: 10000 });
  assert.equal(currentBudget(prior, 'new-doc', { enabled: true, limit: 10000 }).used, 0);
});
test('page cache touches, replaces and evicts without retaining deleted weight', () => {
  const cache = new PageCache<string>(2, 100);
  cache.set('a', 'one'); cache.set('b', 'two'); cache.get('a'); cache.set('c', 'three');
  assert.equal(cache.get('b'), undefined);
  for (let i = 0; i < 100; i++) cache.set('a', 'replacement');
  assert.equal(cache.size, 2);
  cache.delete('a'); cache.set('d', 'four'); assert.equal(cache.size, 2);
  cache.set('oversized', 'x'.repeat(200)); assert.equal(cache.get('oversized'), undefined);
  cache.clear(); assert.equal(cache.size, 0);
});
test('cache provider identity is stable across unrelated settings saves', () => {
  const settings = { provider: 'ollama' as const, ollamaOrigin: 'http://127.0.0.1:11434', ollamaModel: 'qwen3.5:4b', version: 1 };
  assert.equal(providerIdentity(settings), providerIdentity({ ...settings, version: 9 }));
  assert.notEqual(providerIdentity(settings), providerIdentity({ ...settings, ollamaModel: 'another-model' }));
});
test('page identity distinguishes route changes and ignores ordinary anchors', () => {
  assert.equal(pageUrlIdentity('https://example.com/page#section'), 'https://example.com/page');
  assert.notEqual(pageUrlIdentity('https://example.com/#/one'), pageUrlIdentity('https://example.com/#/two'));
  assert.notEqual(pageUrlIdentity('https://example.com/#!/one'), pageUrlIdentity('https://example.com/#!/two'));
  assert.notEqual(pageUrlIdentity('https://example.com/?page=1'), pageUrlIdentity('https://example.com/?page=2'));
});
