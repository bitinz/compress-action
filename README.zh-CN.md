# Bitinz 图片压缩 Action

用 [Bitinz](https://bitinz.com) API 压缩仓库里的 PNG、JPG 和 WebP 图片。默认只处理 PR 或 push 新增、修改的图片，在 Job Summary 里列出压缩结果，也可以把压缩后的文件提交回分支。

[English](README.md)

## 配置

1. 在 [bitinz.com](https://bitinz.com/zh/register) 免费注册，在[控制台 → API 密钥](https://bitinz.com/zh/dashboard?tab=keys)里创建 key。
2. 把 key 存为仓库 secret，命名为 `BITINZ_API_KEY`（Settings → Secrets and variables → Actions）。
3. 添加工作流。

### 在 PR 中压缩图片并提交

```yaml
name: Compress images
on:
  pull_request:
    paths: ['**.png', '**.jpg', '**.jpeg', '**.webp']
permissions:
  contents: write
jobs:
  compress:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.head_ref }}
      - uses: bitinz/compress-action@v1
        with:
          api-key: ${{ secrets.BITINZ_API_KEY }}
          commit: true
```

检出 `github.head_ref` 后，Action 才能推送到 PR 的分支。来自 fork 的 PR 无法用工作流的 token 推送：图片照样压缩并列出结果，但不会提交。

### 只报告，不提交

去掉 `commit: true` 和 `ref` 即可。Job Summary 会列出每张图片压缩前后的大小；`markdown` 输出是同一张表，可以用来发 PR 评论。

### 定期压缩全部图片

用 `workflow_dispatch` 或 `schedule` 触发时，会检查所有匹配的图片，而不只是改动过的。已经优化过的图片会原样返回、保持不动，但每发送一张仍计入本月额度。

## 输入

| 输入 | 默认值 | 说明 |
|---|---|---|
| `api-key` | （必填） | Bitinz API key，从 secret 读取。 |
| `paths` | `**/*.{png,jpg,jpeg,webp}` | glob 规则或目录，每行一个或用逗号分隔。 |
| `ignore` | | 要排除的 glob 规则，例如 `vendor/**`。 |
| `level` | 账户默认 | `fast`、`default` 或 `best`。 |
| `changed-only` | `true` | PR 和 push 只处理新增或修改的图片。 |
| `min-savings` | `2` | 节省不足这个百分比时保留原图。 |
| `commit` | `false` | 把压缩后的图片提交到分支，需要 `contents: write`。 |
| `commit-message` | `Compress images with Bitinz` | 提交信息。 |
| `github-token` | `${{ github.token }}` | 用来列出 PR 或 push 改动的文件。 |

不会查找 `node_modules` 和 `.git`。Action 始终保持图片原格式，不转成 WebP，所以页面里对图片的引用不受影响。

## 输出

| 输出 | 说明 |
|---|---|
| `files` | 压缩了几张图片。 |
| `bytes-saved` | 一共节省的字节数。 |
| `markdown` | Markdown 格式的结果表。 |

## 额度与隐私

每发送一张图片计入账户每月免费额度一次；开启 `changed-only` 时只发送新增和修改的图片。额度用完时，这一步会失败并给出明确提示，图片保持原样。图片只发送到 `bitinz.com`，处理完几小时后自动删除。详见[隐私政策](https://bitinz.com/zh/privacy)。

命令行工具和给 AI Agent 用的 MCP 服务在 [bitinz/bitinz](https://github.com/bitinz/bitinz)。

## 许可证

MIT。开源的是这个 Action，Bitinz 压缩服务本身不开源。
