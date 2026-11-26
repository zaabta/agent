/** Minimal, deterministic redaction boundary for every externally hosted model call. */
export interface MaskedText {
  text: string;
  replacements: ReadonlyMap<string, string>;
}

const patterns = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:\+?\d[\d ().-]{7,}\d)\b/g,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:password|passcode|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[:=]\s*["']?[^,\s"';&}]+/gi,
];

export function createExternalGptMasker(_tenantId: string) {
  const replacements = new Map<string, string>();
  let index = 0;
  return {
    mask(value: string): string {
      let text = value;
      for (const pattern of patterns) {
        text = text.replace(pattern, original => {
          if (original.includes('[PRIVATE_')) return original;
          const token = `[PRIVATE_${++index}]`;
          replacements.set(token, original);
          return token;
        });
      }
      return text;
    },
    restore(value: string): string {
      let restored = value;
      for (const [token, original] of replacements) restored = restored.split(token).join(original);
      return restored;
    },
  };
}

/** Replacements stay in the caller's request scope and are never sent to the model. */
export function maskForExternalGpt(value: string, tenantId: string): MaskedText {
  const masker = createExternalGptMasker(tenantId);
  const text = masker.mask(value);
  return { text, replacements: new Map([...text.matchAll(/\[PRIVATE_[^\]]+\]/g)].flatMap(match => {
    const token = match[0];
    return masker.restore(token) !== token ? [[token, masker.restore(token)] as const] : [];
  })) };
}

export function maskConversationForExternalGpt<T extends { role: string; content: string }>(
  turns: readonly T[], tenantId: string,
): Array<{ role: string; content: string }> {
  return turns.map(turn => ({ role: turn.role, content: maskForExternalGpt(turn.content, tenantId).text }));
}
