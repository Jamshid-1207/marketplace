import { searchWords, toSearchLatin } from './translit';

describe('транслитерация для поиска (решение 4 SD-05)', () => {
  it.each([
    ['Чойнак', 'choynak'],
    ['Ўзбекистон', 'ozbekiston'],
    ['Oʻzbekiston', 'ozbekiston'],
    ["O'zbekiston", 'ozbekiston'],
    ['Ғалла', 'galla'],
    ['Қовун', 'qovun'],
    ['Ҳаво', 'havo'],
    ['Шахмат', 'shaxmat'],
    ['Юлдуз', 'yulduz'],
    ['Яшил', 'yashil'],
    ['Smartfon 256GB', 'smartfon 256gb'],
  ])('%s → %s', (input, expected) => {
    expect(toSearchLatin(input)).toBe(expected);
  });

  it('кириллица и латиница одного слова совпадают', () => {
    expect(toSearchLatin('Электр чойнак')).toBe(toSearchLatin('Elektr choynak'));
  });

  it('слова запроса: без знаков, в латинице, не больше 10', () => {
    expect(searchWords('  Чойнак, 2 литр!  ')).toEqual(['choynak', '2', 'litr']);
    expect(searchWords('a b c d e f g h i j k l')).toHaveLength(10);
    expect(searchWords('!!!')).toEqual([]);
  });
});
