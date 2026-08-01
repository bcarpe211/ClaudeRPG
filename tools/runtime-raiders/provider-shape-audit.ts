type JsonType = 'array' | 'boolean' | 'null' | 'number' | 'object' | 'string';

function jsonType(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as Exclude<JsonType, 'array' | 'null'>;
}

export function auditJsonlShape(lines: Iterable<string>): Record<string, string[]> {
  const shapes = new Map<string, Set<string>>();

  const record = (path: string, type: string): void => {
    const types = shapes.get(path) ?? new Set<string>();
    types.add(type);
    shapes.set(path, types);
  };

  const walk = (value: unknown, path: string): void => {
    const type = jsonType(value);
    if (path) record(path, type);

    if (type === 'object') {
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const childPath = path ? `${path}.${key}` : key;
        walk((value as Record<string, unknown>)[key], childPath);
      }
    } else if (type === 'array') {
      for (const item of value as unknown[]) walk(item, `${path}[]`);
    }
  };

  for (const line of lines) {
    try {
      walk(JSON.parse(line) as unknown, '');
    } catch {
      record('$malformed', 'malformed');
    }
  }

  return Object.fromEntries(
    [...shapes]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, types]) => [key, [...types].sort()]),
  );
}
