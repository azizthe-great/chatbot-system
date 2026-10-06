const test = require('node:test');
const assert = require('node:assert/strict');

const { getReply } = require('../chatbot');

test('replies to a greeting', () => {
  assert.match(getReply('hello there'), /hello/i);
});

test('answers basic help requests', () => {
  assert.match(getReply('what can you help me with'), /help/i);
});

test('returns a fallback response for unknown messages', () => {
  assert.match(getReply('something random'), /help/i);
});
