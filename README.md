# dsh-api-testgen · 接口测试生成

解析 OpenAPI 3.x（JSON / YAML），为每个接口生成覆盖 **成功 2xx / 缺少必填路径参数 / 非法枚举值** 的接口测试用例，输出 Python（pytest + requests）或 TypeScript（vitest + fetch）测试骨架。纯 Node 实现，无网络、无外部服务。

## 提供的工具

| 工具 | 作用 |
|---|---|
| `gen_tests` | 解析规范，生成接口测试文件（pytest 或 vitest） |

## 安装

```bash
dsh plugin add dsh-api-testgen
```

安装后在 profile 的 `package.json` 的 `dsh.profile.bundles` 中加入 `"dsh-api-testgen"`。

## 用法示例

```
根据 openapi.yaml 生成 Python 接口测试
→ 调用 gen_tests(spec="openapi.yaml", lang="python")

生成 TypeScript(vitest) 接口测试
→ 调用 gen_tests(spec="openapi.yaml", lang="typescript", outDir="./src/__tests__")
```

## 说明

- 每个接口生成：成功用例 + 每个必填路径参数的缺参用例 + 每个枚举参数的非法值用例。
- 生成的测试只是**骨架**（断言状态码），具体业务断言需按需补充；运行前改 `BASE_URL`。
- 与 `dsh-api-contract`（客户端）、`dsh-api-mock`（Mock 服务器）配合，构成 API 开发三件套。

## 安装

```bash
dsh plugin add github:uckkk/dsh-api-testgen
```

> 安装即在本机运行第三方代码，请自行审阅源码。

## 安装

```bash
dsh plugin add github:uckkk/dsh-api-testgen
```
