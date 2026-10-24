import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const src = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, next) {
  if (url.startsWith(src) && url.endsWith('.js')) {
    return { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
  }
  return next(url, context);
} });
const { Scheduler } = await import('../src/streaming/scheduler.js');

function clock(t) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  return { advance(ms) { now += ms; } };
}

test('terrain continuations retain priority ahead of vegetation across frames', (t) => {
  const timer = clock(t), scheduler = new Scheduler(3), order = [];
  scheduler.push('veg:near', 4, () => order.push('vegetation'));
  let slice = 0;
  function terrain() {
    order.push(`terrain:${++slice}`);
    timer.advance(3);
    return slice < 3 ? terrain : undefined;
  }
  scheduler.push('terr:near', 0, terrain);
  for (let frame = 0; frame < 3; frame++) assert.equal(scheduler.run(), 1);
  assert.deepEqual(order, ['terrain:1', 'terrain:2', 'terrain:3']);
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.run(), 1);
  assert.deepEqual(order, ['terrain:1', 'terrain:2', 'terrain:3', 'vegetation']);
});

test('one key remains resident throughout all slices and releases on completion', (t) => {
  const timer = clock(t), scheduler = new Scheduler(1);
  let slice = 0;
  function build() {
    assert.equal(scheduler.has('tile'), true);
    assert.equal(scheduler.pending, 1);
    assert.equal(scheduler.push('tile', -10, () => assert.fail('duplicate ran')), false);
    timer.advance(1);
    return ++slice < 2 ? build : undefined;
  }
  assert.equal(scheduler.push('tile', 0, build), true);
  scheduler.run();
  assert.equal(scheduler.has('tile'), true);
  assert.equal(scheduler.pending, 1);
  scheduler.run();
  assert.equal(scheduler.has('tile'), false);
  assert.equal(scheduler.pending, 0);
  assert.equal(scheduler.push('tile', 0, () => {}), true);
});

test('dropping a partially built tile never executes its remaining slices', (t) => {
  const timer = clock(t), scheduler = new Scheduler(1);
  scheduler.push('terr:old', 0, () => {
    timer.advance(1);
    return () => assert.fail('cancelled tile resumed');
  });
  scheduler.run();
  scheduler.drop((key) => key === 'terr:old');
  assert.equal(scheduler.has('terr:old'), false);
  assert.equal(scheduler.pending, 0);
  assert.equal(scheduler.run(), 0);
  assert.equal(scheduler.drain(), true);
});

test('a new high-priority task preempts a continuation in the same frame', (t) => {
  clock(t);
  const scheduler = new Scheduler(), order = [];
  scheduler.push('terr:normal', 0, () => {
    order.push('start');
    scheduler.push('terr:urgent', -100, () => order.push('urgent'));
    return () => order.push('finish');
  });
  scheduler.push('veg:detail', 4, () => order.push('vegetation'));
  assert.equal(scheduler.run(), 4);
  assert.deepEqual(order, ['start', 'urgent', 'finish', 'vegetation']);
});

test('reprioritising inside a slice applies to both active and queued jobs', (t) => {
  clock(t);
  const scheduler = new Scheduler(), order = [];
  scheduler.push('terr:near', 0, () => {
    order.push('start');
    scheduler.reprioritise((key, priority) => key === 'terr:near' ? 100 : priority);
    return () => order.push('finish');
  });
  scheduler.push('terr:needed', 1, () => order.push('needed'));
  scheduler.run();
  assert.deepEqual(order, ['start', 'needed', 'finish']);
});

test('an active job can be dropped and replaced under the same key', (t) => {
  clock(t);
  const scheduler = new Scheduler(), order = [];
  scheduler.push('tile', 0, () => {
    scheduler.drop((key) => key === 'tile');
    assert.equal(scheduler.push('tile', 0, () => order.push('replacement')), true);
    return () => assert.fail('cancelled continuation resurrected');
  });
  scheduler.run();
  assert.deepEqual(order, ['replacement']);
  assert.equal(scheduler.pending, 0);
  assert.equal(scheduler.has('tile'), false);
});

test('dropping a different job inside a slice preserves the active continuation', (t) => {
  clock(t);
  const scheduler = new Scheduler(), order = [];
  scheduler.push('terr:keep', 0, () => {
    scheduler.drop((key) => key === 'veg:drop');
    return () => order.push('terrain');
  });
  scheduler.push('veg:drop', 1, () => assert.fail('dropped job ran'));
  scheduler.push('veg:keep', 2, () => order.push('vegetation'));
  scheduler.run();
  assert.deepEqual(order, ['terrain', 'vegetation']);
  assert.equal(scheduler.pending, 0);
});

test('clear inside a running slice cancels old jobs without removing new work', (t) => {
  clock(t);
  const scheduler = new Scheduler(), order = [];
  scheduler.push('tile', 0, () => {
    scheduler.clear();
    scheduler.push('tile', 0, () => order.push('replacement'));
    return () => assert.fail('cleared continuation resurrected');
  });
  scheduler.push('other', 1, () => assert.fail('cleared task ran'));
  scheduler.run();
  assert.deepEqual(order, ['replacement']);
  assert.equal(scheduler.pending, 0);
});

test('failures release the key, preserve first error, and do not stop other jobs', (t) => {
  clock(t);
  t.mock.method(console, 'error', () => {});
  const scheduler = new Scheduler(), order = [];
  scheduler.push('bad', 0, () => { throw new Error('generation failed'); });
  scheduler.push('null', 1, () => { throw null; });
  scheduler.push('good', 2, () => order.push('good'));
  assert.equal(scheduler.run(), 3);
  assert.equal(scheduler.error, 'bad: generation failed');
  assert.equal(scheduler.pending, 0);
  assert.equal(scheduler.has('bad'), false);
  assert.deepEqual(order, ['good']);
  scheduler.clear();
  assert.equal(scheduler.error, null);
});

test('frame budget stops between slices, including an over-budget atomic job', (t) => {
  const timer = clock(t), scheduler = new Scheduler(5);
  let slices = 0;
  function build() {
    slices++;
    timer.advance(3);
    return slices < 5 ? build : undefined;
  }
  scheduler.push('terrain', 0, build);
  assert.equal(scheduler.run(), 2);
  assert.equal(slices, 2);
  assert.equal(scheduler.lastDrainMs, 6);
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.run(1), 1);
  assert.equal(scheduler.lastDrainMs, 3);
  assert.equal(scheduler.completed, 3);
});

test('drain obeys its remaining budget and leaves an unfinished job queued', (t) => {
  const timer = clock(t), scheduler = new Scheduler();
  let slices = 0;
  function build() {
    slices++;
    timer.advance(1);
    return slices < 12 ? build : undefined;
  }
  scheduler.push('terrain', 0, build);
  assert.equal(scheduler.drain(5), false);
  assert.equal(slices, 5);
  assert.equal(scheduler.pending, 1);
  assert.equal(scheduler.drain(20), true);
  assert.equal(slices, 12);
});

test('nested run and drain calls do not reenter a running job or spin', (t) => {
  clock(t);
  const scheduler = new Scheduler();
  scheduler.push('terrain', 0, () => {
    assert.equal(scheduler.run(), 0);
    assert.equal(scheduler.drain(), false);
  });
  assert.equal(scheduler.run(), 1);
  assert.equal(scheduler.pending, 0);
});
