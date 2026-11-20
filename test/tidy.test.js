import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tidy, wordCount } from '../public/tidy.js';

test('ums go, and a full stop an um carried stays', () => {
  assert.deepEqual(tidy('um so the launch moves to uh Monday um. we will confirm on Thursday'), { text: 'So the launch moves to Monday. We will confirm on Thursday.', fillers: 3, repeats: 0 });
  assert.equal(tidy('Um, hello there.').text, 'Hello there.');
});

test('a word said twice by mistake is said once, and one said twice on purpose is kept', () => {
  assert.deepEqual(tidy('tell the the team that we we are ready'), { text: 'Tell the team that we are ready.', fillers: 0, repeats: 2 });
  assert.equal(tidy('I know that that plan had had problems').text, 'I know that that plan had had problems.');
  assert.equal(tidy('call 7 7 4 2').text, 'Call 7 7 4 2.', 'numbers are never a repeat');
  assert.equal(tidy('It ended. Ended badly.').text, 'It ended. Ended badly.', 'across a full stop is two sentences');
});

test('each language has its own ums, and automatic knows them all', () => {
  assert.equal(tidy('euh bonjour à toute l’équipe, heu, merci', 'fr').text, 'Bonjour à toute l’équipe, merci.');
  assert.equal(tidy('äh guten Morgen ähm zusammen', 'de').text, 'Guten Morgen zusammen.');
  assert.equal(tidy('eh buenos días', 'es').text, 'Buenos días.');
  assert.equal(tidy('eh buenos días', 'en').text, 'Eh buenos días.', 'an English speaker’s "eh" is a word');
  assert.equal(tidy('äh hello heu there', 'any').text, 'Hello there.');
});

test('what is already tidy is left alone, and nothing is still nothing', () => {
  const clean = 'Your code is 7429. Your appointment is on Tuesday, March 3rd, at 9.45 a.m.';
  assert.deepEqual(tidy(clean), { text: clean, fillers: 0, repeats: 0 });
  assert.deepEqual(tidy('  '), { text: '', fillers: 0, repeats: 0 });
  assert.deepEqual(tidy('um uh'), { text: '', fillers: 2, repeats: 0 });
});

test('words are counted without the punctuation', () => {
  assert.equal(wordCount('Hello, there — it is 9.45 a.m.'), 6);
  assert.equal(wordCount(''), 0);
});
