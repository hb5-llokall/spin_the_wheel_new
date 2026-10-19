import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REWARD_CONFIG as CFG } from '../src/reward-config.js';

// db.js needs a connection string at import time; nothing here connects.
process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test';
const { PLAN_MODE_FOR, getRewardEngineMode, isRewardEngineServing } = await import('../src/reward-engine.js');
const { getWheelSections } = await import('../src/spin-wheel-service.js');

test('REWARD_ENGINE parsing: anything unknown is off', () => {
  assert.equal(getRewardEngineMode({}), 'off');
  assert.equal(getRewardEngineMode({ REWARD_ENGINE: 'ON' }), 'off');
  assert.equal(getRewardEngineMode({ REWARD_ENGINE: 'dry_run' }), 'dry_run');
  assert.equal(getRewardEngineMode({ REWARD_ENGINE: 'on' }), 'on');
  assert.equal(isRewardEngineServing({ REWARD_ENGINE: 'dry_run' }), false);
  assert.equal(isRewardEngineServing({ REWARD_ENGINE: 'on' }), true);
});

test('dry run stores shadow plans, on stores live plans, off stores nothing', () => {
  assert.equal(PLAN_MODE_FOR.dry_run, 'shadow');
  assert.equal(PLAN_MODE_FOR.on, 'live');
  assert.equal(PLAN_MODE_FOR.off, undefined);
});

const coinsOn = (mode) => new Set(getWheelSections(mode).map((s) => s.reward_coins));

test('wheel shows only winnable prizes: legacy rule pays 10 or 50', () => {
  for (const mode of ['off', 'dry_run']) {
    assert.deepEqual([...coinsOn(mode)].sort((a, b) => a - b), [0, 10, 50], mode);
  }
});

test('wheel with the engine on shows Better Luck and the plan prizes only', () => {
  assert.deepEqual([...coinsOn('on')].sort((a, b) => a - b), [0, ...CFG.prizes]);
  assert.ok(!coinsOn('on').has(500));
  for (const section of getWheelSections('on')) {
    assert.ok(section.icon && section.label && section.color && section.text && section.reward_key);
  }
});
