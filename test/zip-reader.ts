// Reads a ZIP back with standard tools: Python's zipfile, which handles
// ZIP64, and Info-ZIP's unzip where it is installed.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const READ = `
import sys, json, zipfile, base64, io

class Sparse(io.RawIOBase):
    """The archive as its non-zero segments, with zeros everywhere else."""
    def __init__(self, spec):
        self.size = spec["size"]
        self.segs = [(s["offset"], base64.b64decode(s["data"])) for s in spec["segments"]]
        self.pos = 0
    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos
    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos
    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        if n <= 0: return 0
        b[:n] = bytes(n)
        for o, d in self.segs:
            lo, hi = max(o, self.pos), min(o + len(d), self.pos + n)
            if lo < hi: b[lo - self.pos:hi - self.pos] = d[lo - o:hi - o]
        self.pos += n
        return n

src = sys.argv[1]
if len(sys.argv) > 3:
    src = io.BufferedReader(Sparse(json.load(open(src))), 1 << 16)
z = zipfile.ZipFile(src)
mode = sys.argv[2]
bad = z.testzip() if mode == "check" else None
out = []
for i in z.infolist():
    data = None
    if mode == "check" or (mode == "small" and i.file_size < 1 << 20):
        data = z.read(i)
    out.append({"name": i.filename, "size": i.file_size, "method": i.compress_type,
                "offset": i.header_offset,
                "data": None if data is None else base64.b64encode(data).decode()})
print(json.dumps({"bad": bad, "entries": out}))
`;

function python(): string {
  for (const cmd of ["python3", "python"]) {
    try {
      execFileSync(cmd, ["-c", "import zipfile"], { stdio: "ignore" });
      return cmd;
    } catch {
      // Windows answers python3 with a store hint.
    }
  }
  throw new Error("these tests need Python 3 to read the ZIP back");
}

export interface ReadEntry {
  name: string;
  size: number;
  method: number;
  offset: number;
  data: Uint8Array | null;
}

/**
 * How much to read: "check" verifies every CRC and returns all data, "small"
 * returns the CRC-checked data of entries under 1 MiB, "list" only the entries.
 */
type Mode = "check" | "small" | "list";

function readZipFile(path: string, mode: Mode, sparse = false): ReadEntry[] {
  const args = ["-I", "-c", READ, path, mode, ...(sparse ? ["sparse"] : [])];
  const out = execFileSync(python(), args, {
    maxBuffer: 1 << 30,
  }).toString();
  const { bad, entries } = JSON.parse(out) as {
    bad: string | null;
    entries: (Omit<ReadEntry, "data"> & { data: string | null })[];
  };
  if (bad) throw new Error(`zipfile: bad CRC in ${bad}`);
  return entries.map((e) => ({ ...e, data: e.data === null ? null : new Uint8Array(Buffer.from(e.data, "base64")) }));
}

/** Runs unzip -t on the bytes when unzip is installed; returns false when it is not. */
export function unzipTest(bytes: Uint8Array): boolean {
  const dir = mkdtempSync(join(tmpdir(), "cp-zip-"));
  try {
    const path = join(dir, "t.zip");
    writeFileSync(path, bytes);
    try {
      execFileSync("unzip", ["-v"], { stdio: "ignore" });
    } catch {
      return false;
    }
    execFileSync("unzip", ["-tqq", path]);
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function allZero(b: Uint8Array): boolean {
  const words = b.byteOffset % 4 === 0 ? new Uint32Array(b.buffer, b.byteOffset, b.length >> 2) : null;
  const from = words ? words.length * 4 : 0;
  if (words) for (const w of words) if (w !== 0) return false;
  for (let i = from; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

/**
 * Reads a ZIP stream too large for the disk of a test run: only its non-zero
 * chunks are kept, and zipfile reads zeros everywhere else. Entry data is
 * returned for entries under 1 MiB, CRC checked.
 */
export async function readLargeZip(zip: ReadableStream<Uint8Array>): Promise<{ size: number; entries: ReadEntry[] }> {
  const segments: { offset: number; data: string }[] = [];
  let size = 0;
  await zip.pipeTo(
    new WritableStream({
      write(chunk) {
        if (!allZero(chunk)) segments.push({ offset: size, data: Buffer.from(chunk).toString("base64") });
        size += chunk.length;
      },
    }),
  );
  const dir = mkdtempSync(join(tmpdir(), "cp-zip-"));
  try {
    const path = join(dir, "sparse.json");
    writeFileSync(path, JSON.stringify({ size, segments }));
    return { size, entries: readZipFile(path, "small", true) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Reads ZIP bytes through a temporary file. */
export function readZip(bytes: Uint8Array, mode: Mode = "check"): ReadEntry[] {
  const dir = mkdtempSync(join(tmpdir(), "cp-zip-"));
  try {
    const path = join(dir, "t.zip");
    writeFileSync(path, bytes);
    return readZipFile(path, mode);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
