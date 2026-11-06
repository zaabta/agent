function normalizeInventoryText(input: string): string {
  return input.normalize('NFKD').toLocaleLowerCase('tr-TR').replace(/\p{M}/gu, '').replace(/\u0131/g, 'i').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Deterministic routing is intentionally limited to an explicit inventory request. */
export function isDocumentInventoryIntent(message: string): boolean {
  const text = normalizeInventoryText(message);
  const words = text.split(' ');
  const arabicVerbs = ['\u0627\u0639\u0631\u0636', '\u0627\u0630\u0643\u0631', '\u0642\u0627\u0626\u0645\u0629'];
  const arabicNouns = ['\u0627\u0644\u0645\u0633\u062A\u0646\u062F\u0627\u062A', '\u0627\u0644\u0648\u062B\u0627\u0626\u0642', '\u0627\u0644\u0645\u0644\u0641\u0627\u062A'];
  const arabicInventory = arabicVerbs.includes(words[0] ?? '') && arabicNouns.some(noun => words.at(-1) === noun);
  return /^(?:please )?(?:list|show) (?:me )?(?:(?:all|my|our|the) )?(?:workspace )?(?:documents|files)(?: in (?:my|our) workspace)?$/u.test(text)
    || /^(?:belgelerimi|dokumanlarimi|dosyalarimi) listele$/u.test(text)
    || /^(?:(?:list|show) )?(?:my )?(?:files|documents)$/u.test(text)
    || arabicInventory;
}
