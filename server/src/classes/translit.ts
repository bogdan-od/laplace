/**
 * Ukrainian to Latin transliteration by the official table: Resolution of the Cabinet of
 * Ministers of Ukraine No. 55 of 27 January 2010. Used to make logins from surnames.
 */

/** Letters with one spelling everywhere. The apostrophe and the soft sign give an empty string. */
export const UK_LETTERS: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'h',
  ґ: 'g',
  д: 'd',
  е: 'e',
  ж: 'zh',
  з: 'z',
  и: 'y',
  і: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ь: '',
  "'": '',
  ʼ: '',
  '’': '',
};

/** Letters spelled differently at the beginning of a word: [at the start, elsewhere]. */
export const UK_WORD_START: Readonly<
  Record<string, readonly [string, string]>
> = {
  є: ['ye', 'ie'],
  ї: ['yi', 'i'],
  й: ['y', 'i'],
  ю: ['yu', 'iu'],
  я: ['ya', 'ia'],
};

/** "зг" is written "zgh" so that it is not read as "zh". */
const ZGH = 'zgh';

const isLatinOrDigit = (char: string): boolean => /^[a-z0-9]$/.test(char);

/** Lower-case transliteration; characters outside the table are dropped, except Latin letters, digits and "-". */
export function transliterate(text: string): string {
  const lower = text.toLowerCase();
  let out = '';
  let atWordStart = true;
  for (let i = 0; i < lower.length; i++) {
    const char = lower.charAt(i);
    if (char === 'з' && lower.charAt(i + 1) === 'г') {
      out += ZGH;
      i++;
      atWordStart = false;
      continue;
    }
    const start = UK_WORD_START[char];
    const letter = UK_LETTERS[char];
    if (start) {
      out += atWordStart ? start[0] : start[1];
    } else if (letter !== undefined) {
      out += letter;
    } else if (isLatinOrDigit(char) || char === '-') {
      out += char;
    }
    // The apostrophe and soft sign do not start a new word, so a following я stays "ia".
    atWordStart = !(
      char in UK_LETTERS ||
      char in UK_WORD_START ||
      isLatinOrDigit(char)
    );
  }
  return out;
}
