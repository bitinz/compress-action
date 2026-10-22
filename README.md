# Bitinz Image Compression Action

Compress the PNG, JPG and WebP images in your repository with the [Bitinz](https://bitinz.com) API. By default it checks only the images a pull request or push adds or changes, writes a summary table to the job, and can commit the smaller files back to the branch.

[简体中文](README.zh-CN.md)

## Setup

1. Create a free account at [bitinz.com](https://bitinz.com/register) and an API key under [Dashboard → API keys](https://bitinz.com/dashboard?tab=keys).
2. Add the key to your repository as a secret named `BITINZ_API_KEY` (Settings → Secrets and variables → Actions).
3. Add a workflow.

### Compress images in pull requests and commit them

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

Checking out `github.head_ref` lets the action push to the pull request's branch. Pull requests from forks cannot be pushed to with the workflow's token; their images are still compressed and reported, but not committed.

### Only report, never commit

```yaml
      - uses: actions/checkout@v7
      - uses: bitinz/compress-action@v1
        with:
          api-key: ${{ secrets.BITINZ_API_KEY }}
```

The job summary lists each image with its size before and after. The `markdown` output holds the same table, for example to post as a pull request comment.

### Compress every image now and then

```yaml
on:
  workflow_dispatch:
  schedule:
    - cron: '0 3 * * 1'
```

For these events every matching image is checked, not only changed ones. Already optimized images come back unchanged and are left alone, but each one sent still counts towards your monthly quota.

## Inputs

| Input | Default | |
|---|---|---|
| `api-key` | (required) | Your Bitinz API key, from a secret. |
| `paths` | `**/*.{png,jpg,jpeg,webp}` | Glob patterns or folders, one per line or comma-separated. |
| `ignore` | | Glob patterns to leave out, e.g. `vendor/**`. |
| `level` | account default | `fast`, `default` or `best`. |
| `changed-only` | `true` | For pull requests and pushes, only images they add or change. |
| `min-savings` | `2` | Keep an image as it is when compression saves less than this percentage. |
| `commit` | `false` | Commit the compressed images to the branch. Needs `contents: write`. |
| `commit-message` | `Compress images with Bitinz` | |
| `github-token` | `${{ github.token }}` | Used to list the files a pull request or push changes. |

`node_modules` and `.git` are never searched. The action keeps every image in its format; it does not convert to WebP, so references to your images keep working.

## Outputs

| Output | |
|---|---|
| `files` | Number of images compressed. |
| `bytes-saved` | Total bytes saved. |
| `markdown` | The summary table in Markdown. |

## Quota and privacy

Every image sent uses one compression of your account's free monthly quota; with `changed-only` the action sends only new and changed images. If the quota runs out, the step fails with a clear message and the images stay as they were. Images are sent only to `bitinz.com` and are deleted from its servers automatically after a few hours. See the [privacy policy](https://bitinz.com/privacy).

The command line tool and the MCP server for AI agents are in [bitinz/bitinz](https://github.com/bitinz/bitinz).

## License

MIT. This action is open source; the Bitinz compression service itself is not.
