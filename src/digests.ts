import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { canonicalize } from "json-canonicalize";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function manifestDigest(value: unknown): string {
  return `sha256:${sha256(canonicalJson(value))}`;
}

function normalizedPath(root: string, absolute: string): string {
  const value = relative(root, absolute);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || value.includes("\0")) throw new Error(`path escapes digest root: ${absolute}`);
  const normalized = value.split(sep).join("/").normalize("NFC");
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe digest path: ${value}`);
  return normalized;
}

type Entry = ["file", string, "regular" | "executable", string] | ["symlink", string, string] | ["directory", string];

export async function treeDigest(rootInput: string): Promise<string> {
  const root = resolve(rootInput);
  if ((await lstat(root)).isSymbolicLink()) throw new Error("digest root cannot be a symlink");
  const entries: Entry[] = [];
  const encountered = new Set<string>();
  async function walk(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    let included = 0;
    for (const child of children) {
      if (child.name === ".git") continue;
      included += 1;
      const absolute = join(directory, child.name);
      const path = normalizedPath(root, absolute);
      if (encountered.has(path)) throw new Error(`duplicate normalized path: ${path}`);
      encountered.add(path);
      const stat = await lstat(absolute);
      if (stat.isDirectory()) await walk(absolute);
      else if (stat.isFile()) entries.push(["file", path, stat.mode & 0o111 ? "executable" : "regular", sha256(await readFile(absolute))]);
      else if (stat.isSymbolicLink()) entries.push(["symlink", path, await readlink(absolute)]);
      else throw new Error(`unsupported tree entry: ${path}`);
    }
    if (included === 0 && directory !== root) {
      const path = normalizedPath(root, directory);
      entries.push(["directory", path]);
    }
  }
  await walk(root);
  entries.sort((left, right) => left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0);
  return `tree-sha256-v1:${sha256(canonicalJson(entries))}`;
}
