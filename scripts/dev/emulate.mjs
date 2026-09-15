// 本地预览用的最小运行时：D1 → node:sqlite，R2 → 本地目录。
import { DatabaseSync } from "node:sqlite";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";

const encoder = new TextEncoder();

export function createD1(dbPath, migrationsDir) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT name FROM _migrations").all().map((row) => row.name));
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    db.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
    db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
  }

  const toResult = (info) => ({
    success: true,
    meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
  });

  const prepare = (sql) => {
    let bound = [];
    const args = (direct) => (direct.length ? direct : bound);
    const api = {
      bind(...params) {
        bound = params;
        return api;
      },
      all(...direct) {
        return { results: db.prepare(sql).all(...args(direct)) };
      },
      first(...direct) {
        const rows = db.prepare(sql).all(...args(direct));
        return rows.length ? rows[0] : null;
      },
      run(...direct) {
        return toResult(db.prepare(sql).run(...args(direct)));
      },
    };
    return api;
  };

  return {
    prepare,
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const out = statements.map((statement) => statement.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql) {
      db.exec(sql);
    },
    close() {
      db.close();
    },
  };
}

export function createR2(root) {
  const fileFor = (key) => path.join(root, String(key).split("/").filter((p) => p && p !== "." && p !== "..").join(path.sep));
  const metaFor = (key) => `${fileFor(key)}.meta.json`;

  return {
    async put(key, value, options = {}) {
      const target = fileFor(key);
      mkdirSync(path.dirname(target), { recursive: true });
      const bytes = value instanceof Uint8Array
        ? value
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : encoder.encode(String(value));
      writeFileSync(target, bytes);
      writeFileSync(metaFor(key), JSON.stringify({
        contentType: options.httpMetadata?.contentType || "application/octet-stream",
      }));
      return { key, size: bytes.byteLength };
    },
    async get(key, options = {}) {
      const target = fileFor(key);
      if (!existsSync(target) || !statSync(target).isFile()) return null;
      const bytes = readFileSync(target);
      const meta = existsSync(metaFor(key))
        ? JSON.parse(readFileSync(metaFor(key), "utf8"))
        : { contentType: "application/octet-stream" };
      let body = bytes;
      if (options.range) {
        const start = options.range.offset ?? 0;
        const end = options.range.length ? start + options.range.length : bytes.byteLength;
        body = bytes.subarray(start, end);
      }
      return {
        size: bytes.byteLength,
        httpEtag: `"dev-${bytes.byteLength}"`,
        httpMetadata: { contentType: meta.contentType },
        body: new Blob([body]).stream(),
        async arrayBuffer() {
          return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
        },
        async text() {
          return new TextDecoder().decode(body);
        },
      };
    },
    async delete(key) {
      rmSync(fileFor(key), { force: true });
      rmSync(metaFor(key), { force: true });
    },
  };
}
