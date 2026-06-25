// Recursive sync-state rollup over a /rest/db/browse tree.
//
// /rest/db/browse returns nested objects: directories map to children,
// files are 2-tuples [modtime, size]. /rest/db/need gives us the
// per-file lists (progress / queued / rest) of paths that aren't yet
// synced. We combine the two into per-subtree aggregates the UI can
// surface above a file grid or in a future folder tree browser.
//
// Pure functions only — no React, no daemon calls. Wraps are in
// useFolderAggregate.

export type SyncStatus = "synced" | "syncing" | "pending";

export interface Aggregate {
  // Totals across this subtree.
  totalFiles: number;
  totalBytes: number;
  // Per-status counts and byte totals.
  syncedFiles: number;
  syncedBytes: number;
  syncingFiles: number;
  syncingBytes: number;
  pendingFiles: number;
  pendingBytes: number;
}

export interface AggregateNode extends Aggregate {
  // POSIX-style relative path of this directory ("" = folder root).
  path: string;
  // Subdirectory aggregates, keyed by directory basename.
  children: Record<string, AggregateNode>;
}

export interface NeedSets {
  progress: ReadonlySet<string>;
  pending: ReadonlySet<string>;
}

const EMPTY: Aggregate = {
  totalFiles: 0,
  totalBytes: 0,
  syncedFiles: 0,
  syncedBytes: 0,
  syncingFiles: 0,
  syncingBytes: 0,
  pendingFiles: 0,
  pendingBytes: 0,
};

export function emptyAggregate(): Aggregate {
  return { ...EMPTY };
}

// Walks the browse tree and produces a tree of per-directory aggregates.
// Each node sums every file in its subtree, classified by membership in
// the need-sets.
export function aggregateBrowse(
  browse: unknown,
  need: NeedSets,
  prefix = "",
): AggregateNode {
  const node: AggregateNode = {
    path: prefix,
    children: {},
    ...emptyAggregate(),
  };
  if (!browse || typeof browse !== "object") return node;

  for (const [name, value] of Object.entries(browse as Record<string, unknown>)) {
    const childPath = prefix ? `${prefix}/${name}` : name;
    if (Array.isArray(value)) {
      const size = typeof value[1] === "number" ? (value[1] as number) : 0;
      const status = classify(childPath, need);
      addFile(node, size, status);
    } else {
      const child = aggregateBrowse(value, need, childPath);
      node.children[name] = child;
      mergeInto(node, child);
    }
  }
  return node;
}

// Status of a single file: in active transfer, queued/rest, or already
// in sync (i.e. not mentioned anywhere in /rest/db/need).
export function classify(path: string, need: NeedSets): SyncStatus {
  if (need.progress.has(path)) return "syncing";
  if (need.pending.has(path)) return "pending";
  return "synced";
}

// Lookup helper for callers that don't want to walk the AggregateNode
// tree by hand — pass a POSIX-style relative directory path and get
// back its aggregate, or null if the path doesn't exist.
export function aggregateAt(
  root: AggregateNode,
  relPath: string,
): AggregateNode | null {
  if (!relPath) return root;
  const parts = relPath.split("/").filter((p) => p.length > 0);
  let cur: AggregateNode = root;
  for (const p of parts) {
    const next = cur.children[p];
    if (!next) return null;
    cur = next;
  }
  return cur;
}

// Convenience for callers that have ready-made progress/pending arrays
// (e.g. from /rest/db/need). Both arrays use { name: string } entries.
export function makeNeedSets(args: {
  progress?: { name: string }[];
  queued?: { name: string }[];
  rest?: { name: string }[];
}): NeedSets {
  // Normalize to POSIX-style forward slashes so the sets line up
  // with the keys produced by /rest/db/browse (always "/") and the
  // transfer-store keys (also normalized on ingest).
  const norm = (s: string) => s.replace(/\\/g, "/");
  return {
    progress: new Set((args.progress ?? []).map((p) => norm(p.name))),
    pending: new Set([
      ...(args.queued ?? []).map((p) => norm(p.name)),
      ...(args.rest ?? []).map((p) => norm(p.name)),
    ]),
  };
}

function addFile(node: AggregateNode, size: number, status: SyncStatus): void {
  node.totalFiles += 1;
  node.totalBytes += size;
  if (status === "synced") {
    node.syncedFiles += 1;
    node.syncedBytes += size;
  } else if (status === "syncing") {
    node.syncingFiles += 1;
    node.syncingBytes += size;
  } else {
    node.pendingFiles += 1;
    node.pendingBytes += size;
  }
}

function mergeInto(parent: AggregateNode, child: Aggregate): void {
  parent.totalFiles += child.totalFiles;
  parent.totalBytes += child.totalBytes;
  parent.syncedFiles += child.syncedFiles;
  parent.syncedBytes += child.syncedBytes;
  parent.syncingFiles += child.syncingFiles;
  parent.syncingBytes += child.syncingBytes;
  parent.pendingFiles += child.pendingFiles;
  parent.pendingBytes += child.pendingBytes;
}
