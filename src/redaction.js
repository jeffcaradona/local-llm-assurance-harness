export function createRedactor({ secrets = [], patterns = [] } = {}) {
  const normalized = secrets.filter(Boolean);
  const fieldPatterns = patterns.length
    ? patterns
    : [/(authorization\s*:\s*)([^\s]+)/gi, /(password\s*[=:]\s*)([^\s]+)/gi, /(token\s*[=:]\s*)([^\s]+)/gi];

  return {
    redact(input) {
      let output = input;
      for (const secret of normalized) {
        output = output.split(secret).join('[REDACTED_SECRET]');
      }
      for (const pattern of fieldPatterns) {
        output = output.replace(pattern, '$1[REDACTED_FIELD]');
      }
      return output;
    },
    describe() {
      return {
        explicitSecrets: normalized.length,
        patternCount: fieldPatterns.length,
        note: 'Pattern redaction reduces exposure but does not guarantee complete secret removal.'
      };
    }
  };
}
