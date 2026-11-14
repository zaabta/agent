import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isInsufficientEvidenceReply } from '../src/agent/insufficient-evidence.js';

test('short explicit excerpt-insufficiency replies do not become factual citations in AR/TR/EN', () => {
  for (const text of [
    'لا يوجد إشارة إلى اسم شركة التأمين لمشروع Orion في البيانات المقدمة.',
    'لا يوجد اسم لشركة التأمين لمشروع Orion في الأدلة المقدمة.',
    'The supplied excerpts do not mention the insurer.',
    'I cannot find the insurer in the provided documents.',
    'Verilen belgelerde sigorta şirketinin adı belirtilmemiştir.',
    'الشركة المُؤمنة لمشروع Orion غير مذكورة في المعلومات المتاحة.',
    'The insurer is not specified in the supplied excerpts.',
    'Sigorta şirketinin adı verilen belgelerde belirtilmemiştir.',
  ]) assert.equal(isInsufficientEvidenceReply(text), true, text);
});

test('explicit negative facts and mixed factual answers still require ordinary citation validation', () => {
  for (const text of [
    'No insurance is required for Orion.',
    'The supplied excerpt explicitly states that no insurer has been appointed.',
    'لا توجد بوليصة تأمين للمشروع وفقًا للمستند.',
    'Sunulan belge sigorta gerekmediğini açıkça belirtir.',
    'The supplied excerpts do not mention insurance but the budget is approved.',
    'لا يوجد إشارة إلى اسم شركة التأمين في البيانات المقدمة والمشروع معتمد.',
    'The supplied excerpts do not mention the insurer. The budget is approved.',
    'The supplied excerpts do not mention insurer 42.',
    'The supplied excerpts do not mention the insurer [[unknown]].',
  ]) assert.equal(isInsufficientEvidenceReply(text), false, text);
});
