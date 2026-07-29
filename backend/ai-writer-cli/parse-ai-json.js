const POST_STRING_FIELDS = [
  'title',
  'slug',
  'excerpt',
  'content',
  'seoTitle',
  'seoDescription',
  'seoKeywords',
];

function stripMarkdownFence(text) {
  return String(text || '')
    .replace(/^```(?:json|html)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractJsonObject(text) {
  const cleaned = stripMarkdownFence(text);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return cleaned;
  return cleaned.slice(start, end + 1);
}

function repairLiteralNewlinesInStrings(json) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i += 1) {
    const ch = json[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }

    if (inString) {
      if (ch === '\n') {
        result += '\\n';
        continue;
      }
      if (ch === '\r') continue;
      if (ch === '\t') {
        result += '\\t';
        continue;
      }
    }

    result += ch;
  }

  return result;
}

function unescapeJsonString(value) {
  try {
    return JSON.parse(`"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  } catch {
    return value
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

function extractStringField(raw, field, nextField) {
  const keyPattern = new RegExp(`"${field}"\\s*:\\s*"`, 'i');
  const keyMatch = keyPattern.exec(raw);
  if (!keyMatch) return null;

  let i = keyMatch.index + keyMatch[0].length;
  let value = '';

  while (i < raw.length) {
    const ch = raw[i];

    if (ch === '\\' && i + 1 < raw.length) {
      value += raw.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (ch === '"') {
      const tail = raw.slice(i + 1).trimStart();
      if (nextField && new RegExp(`^,\\s*"${nextField}"\\s*:`).test(tail)) break;
      if (!nextField && /^[,}]/.test(tail)) break;
      value += '"';
      i += 1;
      continue;
    }

    value += ch;
    i += 1;
  }

  return unescapeJsonString(value);
}

function extractNumberField(raw, field) {
  const match = raw.match(new RegExp(`"${field}"\\s*:\\s*(\\d+)`, 'i'));
  return match ? Number(match[1]) : null;
}

function extractPostFields(raw) {
  const result = {};

  for (let index = 0; index < POST_STRING_FIELDS.length; index += 1) {
    const field = POST_STRING_FIELDS[index];
    const nextField = POST_STRING_FIELDS[index + 1] ?? null;
    const value = extractStringField(raw, field, nextField);
    if (value != null) result[field] = value;
  }

  const readingTimeMinutes = extractNumberField(raw, 'readingTimeMinutes');
  if (readingTimeMinutes != null) result.readingTimeMinutes = readingTimeMinutes;

  const required = ['title', 'excerpt', 'content', 'seoTitle', 'seoDescription', 'seoKeywords'];
  const missing = required.filter((field) => !result[field]);
  if (missing.length) {
    throw new Error(`Could not recover AI JSON fields: ${missing.join(', ')}`);
  }

  return result;
}

export function parseAiJson(text, { providerName = 'AI' } = {}) {
  const objectText = extractJsonObject(text);

  const attempts = [
    objectText,
    repairLiteralNewlinesInStrings(objectText),
  ];

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next repair strategy
    }
  }

  if (/"content"\s*:/i.test(objectText)) {
    try {
      return extractPostFields(objectText);
    } catch (error) {
      throw new Error(`${providerName} returned invalid JSON (${error.message}). Re-run the job or switch models.`);
    }
  }

  throw new Error(`${providerName} did not return valid JSON. Re-run the job or switch models.`);
}
