const LEARNING_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const HOST_LABELS = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const HINT_KINDS = new Set([
  "data-plane",
  "locator",
  "navigation",
  "verification",
  "wait",
  "workflow",
]);

export const MAX_SITE_LEARNINGS = 128;
export const MAX_SITE_LEARNING_BYTES = 512 * 1024;

export class SiteLearningError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "SiteLearningError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SiteLearningError("INVALID_SITE_LEARNING", `${label} must be an object`);
  }
  return value;
}

function string(value, label, maximum) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new SiteLearningError(
      "INVALID_SITE_LEARNING",
      `${label} must be a 1-${maximum} character string`,
    );
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function unique(values, normalize) {
  return [...new Set(values.map(normalize))];
}

function hostPattern(value) {
  const normalized = string(value, "learning.match.hosts[]", 253)
    .toLowerCase()
    .replace(/\.$/u, "");
  if (!HOST_LABELS.test(normalized)) {
    throw new SiteLearningError(
      "INVALID_SITE_LEARNING",
      "Host patterns must be exact hosts or one leading '*.' wildcard",
    );
  }
  return normalized;
}

function pathPrefix(value) {
  const normalized = string(value, "learning.match.pathPrefixes[]", 512);
  if (!normalized.startsWith("/")) {
    throw new SiteLearningError(
      "INVALID_SITE_LEARNING",
      "Path prefixes must begin with '/'",
    );
  }
  return normalized;
}

function normalizeLearning(value) {
  const input = object(value, "learning");
  const id = string(input.id, "learning.id", 128);
  if (!LEARNING_ID.test(id)) {
    throw new SiteLearningError(
      "INVALID_SITE_LEARNING",
      "learning.id may contain letters, numbers, '.', '_', ':' and '-'",
    );
  }
  if (!Number.isInteger(input.revision) || input.revision < 1 || input.revision > 1_000_000_000) {
    throw new SiteLearningError(
      "INVALID_SITE_LEARNING",
      "learning.revision must be an integer between 1 and 1000000000",
    );
  }
  const match = object(input.match, "learning.match");
  if (!Array.isArray(match.hosts) || match.hosts.length < 1 || match.hosts.length > 16) {
    throw new SiteLearningError(
      "INVALID_SITE_LEARNING",
      "learning.match.hosts must contain 1-16 host patterns",
    );
  }
  if (match.pathPrefixes !== undefined
    && (!Array.isArray(match.pathPrefixes) || match.pathPrefixes.length > 16)) {
    throw new SiteLearningError(
      "INVALID_SITE_LEARNING",
      "learning.match.pathPrefixes must contain at most 16 prefixes",
    );
  }
  if (!Array.isArray(input.hints) || input.hints.length < 1 || input.hints.length > 32) {
    throw new SiteLearningError(
      "INVALID_SITE_LEARNING",
      "learning.hints must contain 1-32 non-executable hints",
    );
  }
  const hints = input.hints.map((value, index) => {
    const hint = object(value, `learning.hints[${index}]`);
    const kind = string(hint.kind, `learning.hints[${index}].kind`, 64);
    if (!HINT_KINDS.has(kind)) {
      throw new SiteLearningError(
        "INVALID_SITE_LEARNING",
        `Unsupported site-learning hint kind '${kind}'`,
      );
    }
    return {
      kind,
      text: string(hint.text, `learning.hints[${index}].text`, 2_000),
    };
  });
  const normalized = {
    id,
    revision: input.revision,
    match: {
      hosts: unique(match.hosts, hostPattern).sort(),
      pathPrefixes: unique(match.pathPrefixes ?? ["/"], pathPrefix)
        .sort((left, right) => right.length - left.length || left.localeCompare(right)),
    },
    hints,
    ...(input.provenance === undefined
      ? {}
      : { provenance: string(input.provenance, "learning.provenance", 512) }),
    executable: false,
  };
  const bytes = Buffer.byteLength(JSON.stringify(normalized));
  if (bytes > 64 * 1024) {
    throw new SiteLearningError(
      "SITE_LEARNING_TOO_LARGE",
      "One site learning cannot exceed 64 KiB",
    );
  }
  return { normalized, bytes };
}

function parseTarget(value) {
  const raw = typeof value === "string" ? value : value?.url;
  let parsed;
  try {
    parsed = new URL(string(raw, "url", 8_192));
  } catch {
    throw new SiteLearningError("INVALID_SITE_URL", "url must be a valid http(s) URL");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new SiteLearningError("INVALID_SITE_URL", "site learnings match only http(s) URLs");
  }
  return parsed;
}

function matchingHost(pattern, hostname) {
  if (!pattern.startsWith("*.")) {
    return pattern === hostname ? 10_000 + pattern.length : 0;
  }
  const suffix = pattern.slice(2);
  return hostname.endsWith(`.${suffix}`) ? 5_000 + suffix.length : 0;
}

export class SiteLearningRegistry {
  constructor(options = {}) {
    this.maximum = Number.isInteger(options.maximum) ? options.maximum : MAX_SITE_LEARNINGS;
    this.maximumBytes = Number.isInteger(options.maximumBytes)
      ? options.maximumBytes
      : MAX_SITE_LEARNING_BYTES;
    this.records = new Map();
    this.bytes = 0;
  }

  register(value) {
    const { normalized, bytes } = normalizeLearning(value);
    const existing = this.records.get(normalized.id);
    if (existing) {
      if (normalized.revision < existing.value.revision) {
        throw new SiteLearningError(
          "SITE_LEARNING_DOWNGRADE",
          `Refusing to replace '${normalized.id}' revision ${existing.value.revision} with ${normalized.revision}`,
        );
      }
      if (normalized.revision === existing.value.revision) {
        if (JSON.stringify(normalized) !== JSON.stringify(existing.value)) {
          throw new SiteLearningError(
            "SITE_LEARNING_VERSION_CONFLICT",
            `Site learning '${normalized.id}' revision ${normalized.revision} has different content`,
          );
        }
        return { changed: false, learning: clone(existing.value) };
      }
    } else if (this.records.size >= this.maximum) {
      throw new SiteLearningError(
        "SITE_LEARNING_LIMIT",
        `Site-learning limit ${this.maximum} reached`,
      );
    }
    const nextBytes = this.bytes - (existing?.bytes ?? 0) + bytes;
    if (nextBytes > this.maximumBytes) {
      throw new SiteLearningError(
        "SITE_LEARNING_BUDGET",
        `Site-learning byte budget ${this.maximumBytes} exceeded`,
      );
    }
    this.records.set(normalized.id, { value: normalized, bytes });
    this.bytes = nextBytes;
    return { changed: true, learning: clone(normalized) };
  }

  list() {
    return [...this.records.values()]
      .map((entry) => clone(entry.value))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  remove(id) {
    const key = string(id, "learning.id", 128);
    const existing = this.records.get(key);
    if (!existing) return { changed: false, id: key };
    this.records.delete(key);
    this.bytes -= existing.bytes;
    return { changed: true, id: key };
  }

  resolve(value) {
    const parsed = parseTarget(value);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
    const matches = [];
    for (const { value: learning } of this.records.values()) {
      let hostScore = 0;
      let matchedHost = null;
      for (const pattern of learning.match.hosts) {
        const score = matchingHost(pattern, hostname);
        if (score > hostScore) {
          hostScore = score;
          matchedHost = pattern;
        }
      }
      if (!hostScore) continue;
      const matchedPathPrefix = learning.match.pathPrefixes.find(
        (prefix) => parsed.pathname.startsWith(prefix),
      );
      if (!matchedPathPrefix) continue;
      matches.push({
        score: hostScore + matchedPathPrefix.length,
        learning: clone(learning),
        matched: { host: matchedHost, pathPrefix: matchedPathPrefix },
      });
    }
    matches.sort((left, right) => right.score - left.score
      || left.learning.id.localeCompare(right.learning.id));
    return {
      url: parsed.href,
      hostname,
      pathname: parsed.pathname,
      trustedLocalLearnings: true,
      learnings: matches.map(({ learning, matched }) => ({ ...learning, matched })),
    };
  }

  status() {
    return {
      count: this.records.size,
      bytes: this.bytes,
      maximum: this.maximum,
      maximumBytes: this.maximumBytes,
      executable: false,
    };
  }
}
