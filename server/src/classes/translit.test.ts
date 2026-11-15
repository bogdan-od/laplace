import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transliterate, UK_LETTERS, UK_WORD_START } from './translit';

test('five surnames from the task', () => {
  assert.equal(transliterate('Щербак'), 'shcherbak');
  assert.equal(transliterate('Яценко'), 'yatsenko');
  assert.equal(transliterate('Ґудзь'), 'gudz');
  assert.equal(transliterate('Їжак'), 'yizhak');
  assert.equal(transliterate('Згурський'), 'zghurskyi');
});

test('word-initial and later forms of є ї й ю я', () => {
  assert.equal(transliterate('Єнакієве'), 'yenakiieve');
  assert.equal(transliterate('Йосип'), 'yosyp');
  assert.equal(transliterate('Юрій'), 'yurii');
  assert.equal(transliterate('Ілля'), 'illia');
  assert.equal(transliterate('Лук’яненко'), 'lukianenko');
  assert.equal(transliterate('Петренко-Яцюк'), 'petrenko-yatsiuk');
});

test('zgh only for the pair з+г', () => {
  assert.equal(transliterate('Зганяйко'), 'zghaniaiko');
  assert.equal(transliterate('Жигайло'), 'zhyhailo');
});

test('the table covers all 33 letters of the alphabet', () => {
  const alphabet = 'абвгґдеєжзиіїйклмнопрстуфхцчшщьюя';
  for (const letter of alphabet) {
    assert.ok(letter in UK_LETTERS || letter in UK_WORD_START, letter);
  }
});

test('drops characters outside the table and keeps Latin letters, digits and hyphens', () => {
  assert.equal(transliterate('Іванов Ivan_7!'), 'ivanovivan7');
  assert.equal(transliterate('???'), '');
});
