/**
 * Узбекская кириллица → латиница (алфавит 1995 г.) для поиска (решение 4 SD-05). Русские буквы,
 * которых нет в узбекском, тоже переводятся: русский текст получает латинскую форму, а «чайник»
 * и «choynak» не мешают друг другу.
 */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'j',
  з: 'z',
  и: 'i',
  й: 'y',
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
  х: 'x',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sh',
  ъ: '',
  ы: 'i',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  ў: 'o',
  қ: 'q',
  ғ: 'g',
  ҳ: 'h',
};

// oʻ, gʻ и твёрдый знак пишут разными апострофами; в поиске они не различаются и выбрасываются
const APOSTROPHES = /['`ʻʼ‘’]/g;

/** Нижний регистр, латиница, без апострофов: «Ўзбекистон» и «Oʻzbekiston» → «ozbekiston». */
export function toSearchLatin(text: string): string {
  return [...text.toLowerCase()]
    .map((ch) => CYRILLIC_TO_LATIN[ch] ?? ch)
    .join('')
    .replace(APOSTROPHES, '');
}

/** Слова запроса для префиксного поиска: буквы и цифры, не больше 10 слов. */
export function searchWords(query: string): string[] {
  return (toSearchLatin(query).match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 10);
}
