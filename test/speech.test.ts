import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortForSpeech } from '../src/speech.ts';

test('朗读简短版：去演练前缀、取第一句、限 40 字', () => {
  assert.equal(shortForSpeech('（演练）open -a "Lark"'), 'open -a "Lark"');
  assert.equal(shortForSpeech('已打开 social.example.com。接下来需要你：请扫码登录'), '已打开 social.example.com');
  assert.equal(shortForSpeech('一'.repeat(50)).length, 41);
});
