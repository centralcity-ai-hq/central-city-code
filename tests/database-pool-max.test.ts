import assert from 'node:assert/strict';
import test from 'node:test';
import { DB_POOL_MAX_DEFAULT, dbPoolMax } from '../server/database.js';

test('CITY_DB_POOL_MAX sets the pool size per instance within 3-50, else the default', () => {
  assert.equal(dbPoolMax({}), DB_POOL_MAX_DEFAULT);
  assert.equal(dbPoolMax({ CITY_DB_POOL_MAX: '25' }), 25);
  assert.equal(dbPoolMax({ CITY_DB_POOL_MAX: ' 3 ' }), 3);
  assert.equal(dbPoolMax({ CITY_DB_POOL_MAX: '50' }), 50);
  for (const bad of ['2', '51', '0', '-5', '12.5', 'abc', '', '1000'])
    assert.equal(dbPoolMax({ CITY_DB_POOL_MAX: bad }), DB_POOL_MAX_DEFAULT, bad);
});
