import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
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

function assertStringMappingKeys(node: unknown): void {
  if (isMap(node)) {
    for (const item of node.items) {
      if (!item.key || typeof (item.key as { value?: unknown }).value !== "string") throw new Error("YAML mapping keys must be strings");
      assertStringMappingKeys(item.value);
    }
  } else if (isSeq(node)) for (const item of node.items) assertStringMappingKeys(item);
}

export function loadManifestText(text: string, file = "<input>"): unknown {
  try {
    if (file.endsWith(".json")) return jsonValue(parseJson(text, false));
    if (!/\.(ya?ml)$/i.test(file)) throw new Error("manifest must use .json, .yaml, or .yml");
    // Reject explicit tags before conversion; YAML tags have parser-specific semantics.
    if (/(^|[\s\[{,])![A-Za-z!<]/m.test(text)) throw new Error("custom YAML tags are forbidden");
    if (/(^|[\s\[{,])[&*][A-Za-z0-9_-]+|^\s*<<\s*:/m.test(text)) throw new Error("YAML anchors, aliases, and merge keys are forbidden");
    const document = parseDocument(text, { uniqueKeys: true, merge: false, prettyErrors: false, schema: "core" });
    if (document.errors.length > 0) throw new Error(document.errors.map((error) => error.message).join("; "));
    assertStringMappingKeys(document.contents);
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
