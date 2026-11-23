import protobuf from "protobufjs";

type Content = { files: ReadonlyArray<{ path: string; content: Uint8Array }> };

export function orderUpload<T extends Content>(
  contents: T[],
  invalid: (message: string) => Error,
): Array<{ content: T; dependencies: T[] }> {
  if (contents.length < 2) return contents.map((content) => ({ content, dependencies: [] }));
  const owners = new Map<string, T>();
  for (const content of contents) {
    for (const file of content.files) {
      if (!file.path.endsWith(".proto")) continue;
      if (owners.has(file.path)) throw invalid("Uploaded modules share a proto path");
      owners.set(file.path, content);
    }
  }

  const visiting = new Set<T>();
  const resolved = new Map<T, T[]>();
  const decoder = new TextDecoder();
  function visit(content: T): T[] {
    const prior = resolved.get(content);
    if (prior) return prior;
    if (visiting.has(content)) throw invalid("Uploaded modules have a dependency cycle");
    visiting.add(content);
    const dependencies = new Set<T>();
    for (const file of content.files) {
      if (!file.path.endsWith(".proto")) continue;
      const parsed = protobuf.parse(decoder.decode(file.content));
      for (const path of [...(parsed.imports ?? []), ...(parsed.weakImports ?? [])]) {
        const owner = owners.get(path);
        if (!owner || owner === content) continue;
        dependencies.add(owner);
        for (const transitive of visit(owner)) dependencies.add(transitive);
      }
    }
    visiting.delete(content);
    const result = [...dependencies];
    resolved.set(content, result);
    return result;
  }
  for (const content of contents) visit(content);
  return [...resolved].map(([content, dependencies]) => ({ content, dependencies }));
}
