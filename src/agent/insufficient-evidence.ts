/** A narrow deterministic guard for a short, explicit metalinguistic refusal.
 * It does not assess arbitrary factual entailment. In particular, mixed answers
 * and explicit negative facts must still go through normal citation validation.
 */
export function isInsufficientEvidenceReply(answer: string): boolean {
  const text = answer.normalize('NFKC').replace(/\p{M}/gu, '').trim().toLocaleLowerCase();
  if (text.length > 500 || /\[\[|[\n;؛,،:0-9٠-٩]/u.test(text)) return false;
  if (/[.!?؟].+\S/u.test(text) || /(?:\b(?:but|however|although|and|also|ancak|fakat|ama|ve|ayrıca)\b|(?:^|\s)(?:لكن|ولكن|بينما)(?:\s|$)|\sو\S+)/u.test(text)) return false;
  const en = (/^(?:(?:the\s+)?(?:provided|supplied|retrieved|available)\s+(?:excerpts?|evidence|documents?|information|data)\s+(?:(?:do|does)\s+not\s+(?:mention|specify|state|provide|contain)|(?:has|have)\s+no\s+(?:information|details))|(?:i\s+(?:could|can)\s+not|i\s+cannot)\s+find\b)/u.test(text)
    || /\b(?:is|was)\s+not\s+(?:mentioned|specified|provided|stated)\s+in\b/u.test(text))
    && /\b(?:provided|supplied|retrieved|available)\b.*\b(?:excerpts?|evidence|documents?|information|data)\b/u.test(text);
  const ar = (/^(?:لا\s+(?:يوجد|توجد|تتوفر|يتوفر)|لم\s+(?:يرد|ترد|يذكر|تذكر|يتم\s+ذكر))(?:\s|$)/u.test(text)
    || /غير\s+مذكور(?:ة)?(?:\s|$)/u.test(text))
    && /(?:ذكر|اشارة|إشارة|اسم|معلوم|تفاصيل)/u.test(text)
    && /(?:في|ضمن)\s+(?:الادلة|الأدلة|المقاطع|البيانات|المعلومات|المستندات|الوثائق)\s+(?:المقدمة|المتاحة|المسترجعة)/u.test(text);
  const tr = /(?:^|\s)(?:verilen|sunulan|saglanan|sağlanan|mevcut)\b/u.test(text)
    && /(?:alinti|alıntı|belge|veri|bilgi|kanit|kanıt)/u.test(text)
    && /(?:belirtilmemis|belirtilmemiş|bahsedilmiyor|yer almiyor|yer almıyor|bilgi yok)/u.test(text);
  return en || ar || tr;
}
