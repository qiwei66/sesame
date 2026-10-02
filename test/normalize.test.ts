import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalize.ts';

test('去标点、空白、全角，英文转小写', () => {
  assert.equal(normalize('打开飞书。'), '打开飞书');
  assert.equal(normalize(' 打开 飞书！！ '), '打开飞书');
  assert.equal(normalize('查一下我的ＶＰＳ？'), '查一下我的vps');
  assert.equal(normalize('查一下我的VPS'), normalize('查一下我的vps'));
});

test('去句首礼貌前缀与句尾语气词', () => {
  assert.equal(normalize('帮我打开飞书吧'), '打开飞书');
  assert.equal(normalize('请帮我打开飞书'), '打开飞书');
  assert.equal(normalize('嗯，麻烦你打开飞书呢'), '打开飞书');
  assert.equal(normalize('打开飞书一下好吗？'), '打开飞书');
  assert.equal(normalize('帮我查一下我的VPS'), normalize('查一下我的VPS'));
});

test('不做语义模糊：句中不同字就是不同键', () => {
  assert.notEqual(normalize('打开飞书'), normalize('打开飞书文档'));
  assert.notEqual(normalize('打开飞书'), normalize('关闭飞书'));
  assert.notEqual(normalize('音量调小一点'), normalize('音量调大一点'));
  assert.notEqual(normalize('明天早上9点提醒我交材料'), normalize('明天早上10点提醒我交材料'));
  // 句中的「一下」不剥
  assert.equal(normalize('查一下我的vps'), '查一下我的vps');
});

test('整句都是语气词时不剥成空串', () => {
  assert.equal(normalize('吧'), '吧');
  assert.equal(normalize('帮我'), '帮我');
  assert.equal(normalize('。。。'), '');
});
