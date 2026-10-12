# dsh-deterministic-tools

**确定性、离线、有界的本地工具箱** — 一个 DeepSeek Harness 插件，向模型注册 29 个可复现的格式/数据/文本/编码/检查工具。

[![CI](https://github.com/ax2/dsh-deterministic-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/ax2/dsh-deterministic-tools/actions/workflows/ci.yml)
MIT License · DSH 0.2.0-rc.2 验证通过 · Node ≥ 20.10

> 纯本地 · 零网络 · 零凭据 · 无时钟无随机 · 每次调用都带字节回执

---

## 为什么需要它

Agent 在需要「把这段 JSON 格式化」「这段文本里有什么不可见字符」「这个 CIDR 覆盖哪些地址」「这个 base64 解出来是不是 UTF-8」时，目前只能：

1. 调用 `pwsh` / `bash` 硬凑 —— Windows 上引号、GBK/UTF-16 编码、控制台代码页全是坑，一次失败要烧掉好几轮 token；
2. 或者在回答里**心算** —— 不可复现，也无法验证。

而生态里的供给几乎为空：收录的 4,508 个 DSH 插件条目里，正则类全网只有 2 个包、编码类 1 个包，**没有任何「确定性工具箱」形态的插件**；官方 profile 自带的 200+ 个 `@deepseek-ai/*` 包里也只有文件、终端、搜索这类能力，没有格式与数据处理。

本项目把这些操作变成**模型可见的工具**：结构化入参、结构化出参、有界、可复现。

## 设计契约：每个结果都是回执

每个工具的规范返回值固定为：

```json
{
  "result": "…工具自己的载荷…",
  "meta": {
    "bytesIn": 15,
    "bytesOut": 45,
    "truncated": false,
    "notes": []
  }
}
```

模型看到的内容就是 `result`（字符串直接给，对象/数组给格式化 JSON），**只有**当发生截断或需要解释时才会追加一行页脚：

```
[bounded] input=262144B output=262144B
[note] object keys sorted recursively
```

干净的调用不花额外 token；有问题的调用一定说清楚。

### 边界行为（三种，绝不混淆）

| 情况 | 行为 |
|---|---|
| 结构化输入超预算 | **抛错拒绝**：报出实际字节、上限，并明确「没有任何截断或部分处理」 |
| 文本输出超预算 | **截断 + `truncated: true` + note**，截断发生在 code point 边界 |
| 结构化/编码结果超预算 | **整体返回 + 标记**：规范值无法部分裁剪，就明确说出来而不是悄悄弄坏它 |
| 不支持的语法/选项 | **显式拒绝**并列出允许值（不猜、不降级、不静默忽略） |
| 无法保证最小/精确 | 返回诚实标记（如 `text_diff` 的 `coarse: true`、解析器的 `unknown_lines`/`confidence`） |

## 安装

npm（推荐）：

```sh
dsh plugin --profile web add dsh-deterministic-tools
```

预构建 tarball（与 npm 上是同一份产物，无需构建步骤，也避开 pnpm 的 `allowBuilds` 授权）：

```sh
dsh plugin --profile web add https://github.com/ax2/dsh-deterministic-tools/releases/latest/download/dsh-deterministic-tools.tgz
```

要固定版本就把 `latest/download/dsh-deterministic-tools.tgz` 换成 `download/v<version>/dsh-deterministic-tools-<version>.tgz`。

本地开发：不安装，直接挂载构建产物。

```sh
pnpm install && pnpm build
dsh --profile web --patch ./cordis.local-overlay.yml --dump-config   # 先验证层合成
dsh --profile web --patch ./cordis.local-overlay.yml                 # 再启动
```

`cordis.local-overlay.yml`（仓库内已提供，等价的 patch 也可手写）：

```yaml
- insert:
    - id: deterministic-tools-local
      name: 'D:/dsh/dsh-deterministic-tools/lib/index.js'
```

## 配置

`apply(ctx, config)` 接受以下配置（全部可选，含默认值）：

| 字段 | 默认 | 作用 |
|---|---|---|
| `maxInputBytes` | `262144` | 结构化输入的硬上限（UTF-8 字节），超过即拒绝 |
| `maxOutputBytes` | `262144` | 结果渲染的软上限，超过即截断或标记 |
| `maxMatches` | `1000` | 查询/正则返回的匹配数上限 |
| `maxDiffEntries` | `2000` | diff 报告的差异条数上限 |
| `maxPatternChars` | `1000` | 正则表达式长度上限 |
| `regexInputBytes` | `65536` | 正则堆栈上限（JS 回溯无法抢占，所以单独收紧） |
| `maxRecords` | `20000` | CSV 解析/生成的记录数上限 |
| `toolPrefix` | `''` | 工具名前缀，例如 `zidev` → `zidev__json_format` |
| `only` | `[]` | 只注册指定工具（空 = 全部） |

## 工具清单（29 个）

### JSON（5）

| 工具 | 说明 |
|---|---|
| `json_format` | 严格解析 + 固定缩进 + 可选递归键排序 |
| `json_minify` | 压成单行 |
| `json_validate` | 校验并给出**精确的** line / column / position（自带扫描器，不依赖引擎错误文案）；语法错误是成功结果，不是异常 |
| `json_query` | 受限 JSONPath：`$`、`.a`、`['a']`、`[0]`、`[*]`、`..a`，返回规范化路径 |
| `json_diff` | 结构化差异（JSON Pointer + add/remove/replace），标量数组可按多重集比较 |

### 文本（6）

| 工具 | 说明 |
|---|---|
| `text_stats` | 字节 / UTF-16 / code point / 行 / 词 / CJK / 非 ASCII / EOL 风格 |
| `lines_process` | dedupe、trim、drop_empty、compact、sort、sort_desc、reverse、number；保留输入的结尾换行、报告输入 EOL 风格（输出统一 LF） |
| `case_convert` | camel / pascal / snake / upper_snake / kebab / dot / title / lower / upper |
| `text_diff` | 行级统一格式 hunk（带行号）；超出 LCS 单元格预算时降级并标 `coarse: true` |
| `regex_find` | 编号/命名捕获组、字符偏移、1-based 行号，匹配数有界 |
| `regex_replace` | `$1` / `$<name>` / `$$` / `$&` 替换，替换次数有界 |

### 数据（4）

| 工具 | 说明 |
|---|---|
| `yaml_to_json` | YAML → JSON；报出精确行列；限制 anchor/alias 展开（防 billion laughs） |
| `json_to_yaml` | JSON → YAML，固定缩进、可选键排序 |
| `csv_to_json` | RFC 4180（引号、字段内换行）、分隔符自动探测、ragged 行统计 |
| `json_to_csv` | 对象/数组数组 → CSV，列顺序取键的首次出现顺序或显式指定 |

### 编码（8）

| 工具 | 说明 |
|---|---|
| `base64_encode` / `base64_decode` | 标准与 URL-safe 字母表；解码前先校验字母表和 padding；非法 UTF-8 **明确上报** |
| `hex_encode` / `hex_decode` | 可选大小写与分隔符；容忍 `:`/`-`/`,`/空白 |
| `url_encode` / `url_decode` | component / form / path / full 四种模式；畸形 `%` 序列计数上报；孤立代理项（unpaired surrogate）显式拒绝并给出下标 |
| `url_inspect` | 拆解 scheme/host/port/path/query/fragment + 解码参数 + 风险提示（内嵌凭据、明文 HTTP、IDN） |
| `hash_text` | sha256 / sha512 / sha1 / md5，hex 或 base64，支持 base64 二进制输入 |

### 检查（6）

| 工具 | 说明 |
|---|---|
| `unicode_inspect` | 逐 code point：`U+XXXX`、UTF-8 字节、类别、文字系统、显示宽度、标志（控制/不可见/bidi/同形字混淆）；支持 NFC/NFD/NFKC/NFKD 对比 |
| `number_base` | 2–36 进制精确互转（BigInt），支持 `0x/0b/0o` 前缀，越界数字拒绝 |
| `color_convert` | `#rgb`/`#rrggbb`/`#rrggbbaa`/`rgb()`/`hsl()` → hex/RGB/HSL/HSV + 相对亮度 + WCAG 对比度 |
| `cidr_inspect` | IPv4/IPv6 网段：网络地址、掩码、广播、首末地址、地址总数、可用主机数、私有/回环/链路本地/CGNAT/组播/ULA 分类 |
| `jwt_inspect` | 解出 header/payload/alg/kid/签名字节数/exp/iat/nbf，判断是否过期 —— **明确声明不验签** |
| `timestamp_convert` | epoch（s/ms/µs/ns 或按量级自动）与 ISO 8601 互转，含偏移渲染、星期、闰年、分解 |

## 开发

```sh
pnpm install
pnpm typecheck              # tsc --noEmit，0 错误
node --test test/           # 35 个用例，覆盖全部 29 个工具的组装路径
pnpm build                  # 产出 lib/（ESM + .d.ts，导入已改写为 .js）
pnpm smoke                  # 用 lib/ 产物 + stub registry 验证 29 个工具全部注册
```

测试分三类：

1. **组装路径**：`definition.execute(args, exec)` → `definition.output.render()`，断言 `result` / `meta` / 页脚；
2. **契约**：每个工具的 schema、描述长度、注册表参数校验（非法 enum 由 registry 在 `execute` 之前拒绝）；
3. **性质测试**（`test/properties.test.ts`，固定种子可复现）：自写 JSON 扫描器与 `JSON.parse` 的差分对照（400 组含随机变异的语料）、格式化的幂等性与值保持、base64/hex/百分号编码/CSV/进制/时间戳的往返、行操作幂等性。

> 这组性质测试在 v0.1 期间抓到过一个真实缺陷：`lines_process` 会丢掉输入结尾的换行（`"a\nb\n"` → `"a\nb"`）。现在它的结果里带 `trailing_newline` 与 `eol_in`，输出忠实复现结尾换行，跨平台换行会说清「输出统一为 LF」。

## 兼容性与风险

- 官方插件 API 自称 **pre-stable，无冻结承诺**；本插件只依赖最稳定的两个面：`ctx.tools.register(defineTool(...))` 与 `apply(ctx, config)`。
- **验证到什么程度（不夸大）**：`tsc --noEmit` 0 错误；35 个用例在真实 `@deepseek-ai/dsh-tools` 上跑通组装路径（含 registry 的参数校验）；`lib/` 产物被 `scripts/smoke-built.mjs` 加载并注册全部 29 个工具；`dsh --profile web --patch ./cordis.local-overlay.yml --dump-config` 在 `dsh 0.2.0-rc.2` 上合成成功；npm 上的版本用 `dsh plugin --profile <scratch> add` 装进一个临时 profile 后，真实 `dsh` 启动把包括本包 29 个在内的全部工具 schema 发给了模型（会话日志里逐个核对过）。**真实对话也跑通了**：同一个临时 profile 接上本机 desktop profile 用的那条 LLM 路由（`tencent-token-plan`）后，模型在一个真实回合里主动调用了 `json_format`（`indent: 2`、`sort_keys: true`），拿回递归排序后的 JSON 与 `[note]` 页脚并原样复述（会话 `session-0a4eb911`）。**尚未做**：跨多个真实会话的调用统计（这属于 M3）。
- 正则工具无法中断 JS 回溯 ⇒ 用 `regexInputBytes`（默认 64 KiB）与 `maxPatternChars` 把风险框住，并在描述里写明。
- `text_diff` 的精确匹配有单元格预算，超出会给出 `coarse: true`，不假装最小差异。

## Roadmap

1. **Rust/WASM 核心**：把 [zi-devtools](https://github.com/ax2) 的 `zi-json-core` / `zi-text-core` / `zi-regex-core` / `zi-diff-core` 编到 `wasm32-unknown-unknown`，用 Node 内置 `WebAssembly` 加载，把逐字节对照向量（121/174/174 组）直接变成 golden tests。
2. 更多工具：JSON Schema 子集校验、cron 表达式解析、SQL 格式化/参数提取、TOML/INI、JWT 签名校验（需显式密钥入参）、tar/zip 清单读取。
3. `output.presentCall/presentResult` 卡片化，让 Web UI 展示 diff/表格而不是纯文本。

## License

MIT © ax2

---

## English

**Deterministic, offline, bounded local toolbox for DeepSeek Harness** — 29 model-visible tools for JSON, YAML/CSV, text, encodings, hashes and inspection.

- **Pure and reproducible**: no network, no credentials, no filesystem, no clock, no randomness.
- **Every call returns a receipt**: `{ result, meta: { bytesIn, bytesOut, truncated, notes } }`. Model-facing text is exactly `result`; a footer appears only when something was clipped or needs explaining.
- **Explicit failure, never silent degradation**: over-budget structured input is refused with both sizes and an assurance that nothing was partially processed; text output is clipped at code-point boundaries and marked; values that cannot be clipped are returned whole and flagged; unsupported syntax is refused with the allowed set; non-minimal results carry an honest flag (`coarse`, `unknown_lines`, `confidence`).
- **Install**: `dsh plugin --profile web add dsh-deterministic-tools`, or mount the built entry locally with `dsh --profile web --patch ./cordis.local-overlay.yml`.
- **Verified against DSH 0.2.0-rc.2**; only `ctx.tools.register(defineTool(...))` and `apply(ctx, config)` are used, because the official plugin API is explicitly pre-stable.

Tools: `json_format` `json_minify` `json_validate` `json_query` `json_diff` `text_stats` `lines_process` `case_convert` `text_diff` `regex_find` `regex_replace` `yaml_to_json` `json_to_yaml` `csv_to_json` `json_to_csv` `base64_encode` `base64_decode` `hex_encode` `hex_decode` `url_encode` `url_decode` `url_inspect` `hash_text` `unicode_inspect` `number_base` `color_convert` `cidr_inspect` `jwt_inspect` `timestamp_convert`.
