import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { isAlias, isMap, isSeq, parseDocument } from "yaml";
import { createRequire } from "node:module";
import { Diagnostic, ValidationError } from "./types.js";
const require = createRequire(import.meta.url);
const parseJson = require("json-dup-key-validator").parse as (text: string, allowDuplicatedKeys?: boolean) => unknown;

function jsonValue(value: unknown, path = "$"): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new Error(`${path} contains a non-finite number`);
  }
  if (Array.isArray(value)) return value.map((child, index) => jsonValue(child, `${path}[${index}]`));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} is not a JSON object`);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, jsonValue(child, `${path}.${key}`)]));
  }
  throw new Error(`${path} is not representable as JSON`);
}

function assertJsonSafeYaml(node: unknown): void {
  if (!node) return;
  const yamlNode = node as { anchor?: unknown; tag?: unknown; value?: unknown };
  if (isAlias(node)) throw new Error("YAML aliases are forbidden");
  if (typeof yamlNode.anchor === "string") throw new Error("YAML anchors are forbidden");
  if (typeof yamlNode.tag === "string" && yamlNode.tag.startsWith("!")) throw new Error("custom YAML tags are forbidden");
  if (isMap(node)) {
    for (const item of node.items) {
      if (!item.key || typeof (item.key as { value?: unknown }).value !== "string") throw new Error("YAML mapping keys must be strings");
      if ((item.key as { value?: unknown }).value === "<<") throw new Error("YAML merge keys are forbidden");
      assertJsonSafeYaml(item.key); assertJsonSafeYaml(item.value);
    }
  } else if (isSeq(node)) for (const item of node.items) assertJsonSafeYaml(item);
}

export function loadManifestText(text: string, file = "<input>"): unknown {
  try {
    if (extname(file).toLowerCase() === ".json") return jsonValue(parseJson(text, false));
    if (!/\.(ya?ml)$/i.test(file)) throw new Error("manifest must use .json, .yaml, or .yml");
    const document = parseDocument(text, { uniqueKeys: true, merge: false, prettyErrors: false, schema: "core" });
    if (document.errors.length > 0) throw new Error(document.errors.map((error) => error.message).join("; "));
    assertJsonSafeYaml(document.contents);
    return jsonValue(document.toJSON());
  } catch (error) {
    const diagnostic: Diagnostic = { file, code: "load", message: error instanceof Error ? error.message : String(error) };
    throw new ValidationError([diagnostic]);
  }
}

export async function loadManifest(file: string): Promise<unknown> {
  return loadManifestText(await readFile(file, "utf8"), file);
}

export function isManifestPath(file: string): boolean {
  return [".json", ".yaml", ".yml"].includes(extname(file).toLowerCase());
}
