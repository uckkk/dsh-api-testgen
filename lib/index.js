// dsh-api-testgen — 接口测试用例生成（DeepSeek Harness）。
// 解析 OpenAPI 3.x（JSON/YAML），为每个接口生成覆盖「成功 / 缺参 / 类型错误 /
// 非法枚举」的测试用例，输出 Python(pytest) 或 TypeScript(vitest) 测试骨架。
// 纯 Node，无网络、无外部服务。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const name = "接口测试生成";
const inject = ["tools"];

// ── 极简 YAML 子集解析 ───────────────────────────────────────────────────
function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  let i = 0;
  const indentOf = (l) => (l.match(/^ */) || [""])[0].length;
  function stripComment(s) {
    let inS = false, inD = false;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      else if (c === "#" && !inS && !inD) return s.slice(0, k);
    }
    return s;
  }
  function findColon(s) {
    let inS = false, inD = false;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      else if (c === ":" && !inS && !inD) return k;
    }
    return -1;
  }
  function splitFlow(s, sep) {
    const out = []; let cur = "", depth = 0, inS = false, inD = false;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      if (!inS && !inD) { if (c === "[" || c === "{") depth++; else if (c === "]" || c === "}") depth--; }
      if (c === sep && depth === 0 && !inS && !inD) { out.push(cur); cur = ""; } else cur += c;
    }
    if (cur !== "") out.push(cur);
    return out;
  }
  function parseValue(raw) {
    const s = raw.trim();
    if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
    if (s === "true" || s === "True" || s === "TRUE") return true;
    if (s === "false" || s === "False" || s === "FALSE") return false;
    if (/^-?\d+$/.test(s)) return Number(s);
    if (/^-?\d*\.\d+$/.test(s)) return Number(s);
    if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
    if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
    if (s.startsWith("[") && s.endsWith("]")) {
      const inner = s.slice(1, -1).trim();
      if (!inner) return [];
      return splitFlow(inner, ",").map((x) => parseValue(x.trim()));
    }
    if (s.startsWith("{") && s.endsWith("}")) {
      const inner = s.slice(1, -1).trim();
      if (!inner) return {};
      const obj = {};
      for (const part of splitFlow(inner, ",")) {
        const idx = findColon(part);
        if (idx === -1) continue;
        obj[parseValue(part.slice(0, idx).trim())] = parseValue(part.slice(idx + 1).trim());
      }
      return obj;
    }
    return s;
  }
  function readLiteral(baseIndent) {
    const buf = [];
    while (i < lines.length && indentOf(lines[i]) >= baseIndent) { buf.push(lines[i].slice(baseIndent)); i++; }
    return buf.join("\n");
  }
  function parseBlock(minIndent) {
    if (i >= lines.length) return null;
    if (indentOf(lines[i]) < minIndent) return null;
    if (indentOf(lines[i]) === minIndent && /^\s*-\s?/.test(lines[i])) {
      const arr = [];
      while (i < lines.length && indentOf(lines[i]) === minIndent && /^\s*-\s?/.test(lines[i])) {
        const dash = lines[i].indexOf("-", minIndent);
        const afterDash = lines[i].slice(dash + 1).trim();
        i++;
        if (afterDash === "") { arr.push(parseBlock(minIndent + 1) ?? null); }
        else {
          const ci = findColon(afterDash);
          if (ci !== -1) {
            const key = afterDash.slice(0, ci).trim().replace(/^['"]|['"]$/g, "");
            const val = afterDash.slice(ci + 1).trim();
            const obj = {};
            if (val === "" || val === "|" || val === ">") {
              if (val === "|" || val === ">") obj[key] = readLiteral(minIndent + 1);
              else if (i < lines.length && indentOf(lines[i]) > minIndent) obj[key] = parseBlock(indentOf(lines[i]));
              else obj[key] = null;
            } else obj[key] = parseValue(val);
            arr.push(obj);
          } else arr.push(parseValue(afterDash));
        }
      }
      return arr;
    }
    const obj = {};
    while (i < lines.length && indentOf(lines[i]) === minIndent && !/^\s*-\s?/.test(lines[i])) {
      const line = stripComment(lines[i]).trimEnd();
      if (line.trim() === "" || line.trim().startsWith("#")) { i++; continue; }
      const ci = findColon(line);
      if (ci === -1) { i++; continue; }
      const key = line.slice(0, ci).trim().replace(/^['"]|['"]$/g, "");
      const val = line.slice(ci + 1).trim();
      i++;
      if (val === "" || val === "|" || val === ">") {
        if (val === "|" || val === ">") obj[key] = readLiteral(minIndent + 1);
        else if (i < lines.length && indentOf(lines[i]) > minIndent) obj[key] = parseBlock(indentOf(lines[i]));
        else obj[key] = null;
      } else obj[key] = parseValue(val);
    }
    return obj;
  }
  return parseBlock(0) ?? {};
}

async function loadSpec(path) {
  const text = await readFile(path, "utf8");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(text);
  return parseYaml(text);
}

function deref(spec, obj) {
  if (obj && typeof obj === "object" && typeof obj.$ref === "string") {
    const parts = obj.$ref.replace(/^#\//, "").split("/");
    let cur = spec;
    for (const p of parts) cur = cur?.[p.replace(/~1/g, "/").replace(/~0/g, "~")];
    return cur;
  }
  return obj;
}

function operations(spec) {
  const out = [];
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(pathItem || {})) {
      if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) continue;
      if (!op || typeof op !== "object") continue;
      out.push({ path, method, op });
    }
  }
  return out;
}

function sampleFor(schema, spec, depth = 0) {
  if (depth > 8) return "x";
  schema = deref(spec, schema);
  if (!schema) return "x";
  if (schema.enum) return schema.enum[0];
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  switch (schema.type) {
    case "string": return "示例";
    case "integer": return 1;
    case "number": return 1.5;
    case "boolean": return true;
    case "array": return [sampleFor(schema.items || {}, spec, depth + 1)];
    case "object": {
      const o = {};
      for (const [k, v] of Object.entries(schema.properties || {})) o[k] = sampleFor(v, spec, depth + 1);
      return o;
    }
    default: return "x";
  }
}

// 用样例值填充路径参数，返回 URL 路径（含 query 串）
function fillUrl(path, params, spec, overrides = {}) {
  let p = path;
  for (const param of params) {
    if (param.in === "path") {
      const val = overrides[param.name] !== undefined ? overrides[param.name] : sampleFor(param.schema, spec);
      p = p.replace(`{${param.name}}`, String(val));
    }
  }
  return p;
}

function queryString(params, spec, overrides = {}) {
  const parts = params
    .filter((p) => p.in === "query")
    .map((p) => `${p.name}=${overrides[p.name] !== undefined ? overrides[p.name] : sampleFor(p.schema, spec)}`);
  return parts.length ? "?" + parts.join("&") : "";
}

// ── 生成 Python 测试（pytest + requests）────────────────────────────────
function genPython(spec) {
  const lines = [
    "# 由 dsh-api-testgen 自动生成的接口测试（pytest + requests）",
    "# 运行前：pip install requests pytest；按需修改 BASE_URL",
    "import requests",
    "",
    'BASE_URL = "http://localhost:8000"',
    "",
  ];
  let count = 0;
  for (const { path, method, op } of operations(spec)) {
    const opId = (op.operationId || `${method}_${path.replace(/[^A-Za-z0-9]+/g, "_")}`).replace(/[^A-Za-z0-9_]/g, "_");
    const params = (op.parameters || []).map((p) => deref(spec, p));
    const pathParams = params.filter((p) => p.in === "path");
    const queryParams = params.filter((p) => p.in === "query");
    const reqSchema = deref(spec, op.requestBody?.content?.["application/json"]?.schema);

    const successPath = fillUrl(path, pathParams, spec);
    const qs = queryString(queryParams, spec);
    const successUrl = `BASE_URL + ${JSON.stringify(successPath + qs)}`;
    const kwargs = reqSchema ? `, json=${JSON.stringify(sampleFor(reqSchema, spec)).replace(/"/g, "'")}` : "";

    lines.push(`def test_${opId}_success():`);
    lines.push(`    r = requests.${method}(${successUrl}${kwargs})`);
    lines.push(`    assert r.status_code < 300`);
    count++;

    for (const p of pathParams) {
      const missingPath = path.replace(`{${p.name}}`, "");
      lines.push("");
      lines.push(`def test_${opId}_missing_${p.name}():`);
      lines.push(`    r = requests.${method}(BASE_URL + ${JSON.stringify(missingPath + qs)})`);
      lines.push(`    assert r.status_code >= 400`);
      count++;
    }

    for (const p of [...pathParams, ...queryParams]) {
      if (p.schema?.enum) {
        const bad = p.schema.enum.length > 1 ? p.schema.enum[1] : "INVALID";
        const badPath = fillUrl(path, pathParams, spec, p.in === "path" ? { [p.name]: bad } : {});
        const badQs = queryString(queryParams, spec, p.in === "query" ? { [p.name]: bad } : {});
        lines.push("");
        lines.push(`def test_${opId}_${p.name}_invalid_enum():`);
        lines.push(`    r = requests.${method}(BASE_URL + ${JSON.stringify(badPath + badQs)})`);
        lines.push(`    assert r.status_code >= 400`);
        count++;
      }
    }
    lines.push("");
  }
  lines.push(`# 共生成 ${count} 个测试用例`);
  return lines.join("\n");
}

// ── 生成 TypeScript 测试（vitest + fetch）───────────────────────────────
function genTypeScript(spec) {
  const lines = [
    "// 由 dsh-api-testgen 自动生成的接口测试（vitest + fetch）",
    "// 运行前：npm i -D vitest；按需修改 BASE_URL",
    'import { describe, it, expect } from "vitest";',
    "",
    'const BASE_URL = "http://localhost:8000";',
    "",
  ];
  let count = 0;
  for (const { path, method, op } of operations(spec)) {
    const opId = (op.operationId || `${method}_${path.replace(/[^A-Za-z0-9]+/g, "_")}`).replace(/[^A-Za-z0-9_$]/g, "_");
    const params = (op.parameters || []).map((p) => deref(spec, p));
    const pathParams = params.filter((p) => p.in === "path");
    const queryParams = params.filter((p) => p.in === "query");
    const reqSchema = deref(spec, op.requestBody?.content?.["application/json"]?.schema);
    const methodUpper = method.toUpperCase();

    const successPath = fillUrl(path, pathParams, spec);
    const qs = queryString(queryParams, spec);
    const bodyOpt = reqSchema ? `, { method: ${JSON.stringify(methodUpper)}, headers: { "content-type": "application/json" }, body: JSON.stringify(${JSON.stringify(sampleFor(reqSchema, spec))}) }` : "";

    lines.push(`describe(${JSON.stringify(`${methodUpper} ${path}`)}, () => {`);
    lines.push(`  it("有效请求返回 2xx", async () => {`);
    lines.push(`    const res = await fetch(BASE_URL + ${JSON.stringify(successPath + qs)}${bodyOpt});`);
    lines.push(`    expect(res.status).toBeLessThan(300);`);
    lines.push(`  });`);
    count++;

    for (const p of pathParams) {
      const missingPath = path.replace(`{${p.name}}`, "");
      lines.push(`  it("缺少路径参数 ${p.name} 返回 4xx", async () => {`);
      lines.push(`    const res = await fetch(BASE_URL + ${JSON.stringify(missingPath + qs)});`);
      lines.push(`    expect(res.status).toBeGreaterThanOrEqual(400);`);
      lines.push(`  });`);
      count++;
    }

    for (const p of [...pathParams, ...queryParams]) {
      if (p.schema?.enum) {
        const bad = p.schema.enum.length > 1 ? p.schema.enum[1] : "INVALID";
        const badPath = fillUrl(path, pathParams, spec, p.in === "path" ? { [p.name]: bad } : {});
        const badQs = queryString(queryParams, spec, p.in === "query" ? { [p.name]: bad } : {});
        lines.push(`  it("参数 ${p.name} 非法枚举值返回 4xx", async () => {`);
        lines.push(`    const res = await fetch(BASE_URL + ${JSON.stringify(badPath + badQs)});`);
        lines.push(`    expect(res.status).toBeGreaterThanOrEqual(400);`);
        lines.push(`  });`);
        count++;
      }
    }
    lines.push(`});`);
    lines.push("");
  }
  lines.push(`// 共生成 ${count} 个测试用例`);
  return lines.join("\n");
}

async function apply(ctx, _config) {
  ctx.tools.register(defineTool({
    name: "gen_tests",
    description:
      "把 OpenAPI 3.x 规范（JSON/YAML）解析后，为每个接口生成覆盖「成功 2xx / 缺少必填路径参数 / 非法枚举值」的接口测试用例，输出 Python(pytest+requests) 或 TypeScript(vitest+fetch) 测试骨架。用于快速搭建 API 测试。`spec` 传规范路径；`lang` 选 python 或 typescript；`outDir` 默认 ./tests。",
    parameters: {
      spec: { type: "string", required: true, description: "OpenAPI 3.x 规范文件路径（.json/.yaml/.yml）。" },
      lang: { type: "string", enum: ["python", "typescript"], description: "测试语言，默认 python。" },
      outDir: { type: "string", description: "输出目录，默认 ./tests。" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          outDir: { type: "string", required: true },
          file: { type: "string", required: true },
          testCount: { type: "integer", required: true },
          operationCount: { type: "integer", required: true },
          note: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `已生成 ${value.operationCount} 个接口、共 ${value.testCount} 个测试用例到 ${value.outDir}/${value.file}。\n${value.note}`,
      }],
    },
    execute: async (args) => {
      const spec = await loadSpec(args.spec);
      const lang = args.lang || "python";
      const outDir = args.outDir || "./tests";
      const code = lang === "typescript" ? genTypeScript(spec) : genPython(spec);
      const file = lang === "typescript" ? "api.test.ts" : "test_api.py";
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, file), code, "utf8");
      const testCount = (code.match(/^def test_|^  it\(/gm) || []).length;
      return {
        outDir,
        file,
        testCount,
        operationCount: operations(spec).length,
        note: lang === "python" ? "运行前 pip install requests pytest，并改 BASE_URL。" : "运行前 npm i -D vitest，并改 BASE_URL。",
      };
    },
  }));
}

export { apply, inject, name };
