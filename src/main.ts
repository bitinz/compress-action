import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { Bitinz, compressFiles, formatBytes, savedPercent, type BatchReport, type FileReport, type Level } from 'bitinz'
import { appendSummary, booleanInput, input, listInput, log, pullRequestFiles, pushedFiles, readEvent, setOutput, type PullRequestEvent, type PushEvent } from './github.ts'
import { matcher } from './glob.ts'

const DEFAULT_PATHS = ['**/*.{png,jpg,jpeg,webp}']
const IMAGE = /\.(png|jpe?g|webp|avif)$/i
const SKIPPED = new Set(['.git', 'node_modules'])
const ZERO_SHA = /^0+$/

const posix = (path: string) => path.split(sep).join('/')

function allImages(root: string, dir = root, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && !SKIPPED.has(entry.name)) allImages(root, path, found)
    else if (entry.isFile() && IMAGE.test(entry.name)) found.push(posix(relative(root, path)))
  }
  return found
}

// Changed images for pull requests and pushes; every image otherwise.
async function candidates(workspace: string, changedOnly: boolean, token: string): Promise<{ files: string[]; scope: string }> {
  const name = process.env.GITHUB_EVENT_NAME ?? ''
  const repo = process.env.GITHUB_REPOSITORY ?? ''
  if (changedOnly && token && name.startsWith('pull_request')) {
    const event = readEvent<PullRequestEvent>()
    if (event?.pull_request) return { files: await pullRequestFiles(repo, event.pull_request.number, token), scope: `changed in pull request #${event.pull_request.number}` }
  }
  if (changedOnly && token && name === 'push') {
    const event = readEvent<PushEvent>()
    if (event && !ZERO_SHA.test(event.before)) {
      const files = await pushedFiles(repo, event.before, event.after, token)
      if (files) return { files, scope: 'changed in this push' }
      log.notice('The push changes too many files to list; checking every image instead.')
    }
  }
  return { files: allImages(workspace), scope: 'in the repository' }
}

function table(report: BatchReport, workspace: string): string {
  const written = report.files.filter(file => file.status === 'compressed')
  const saved = report.inputBytes - report.outputBytes
  const lines = [
    '### Bitinz image compression', '',
    written.length
      ? `Compressed **${written.length}** of ${report.files.length} image${report.files.length === 1 ? '' : 's'}, saving **${formatBytes(saved)}** (${savedPercent(report.inputBytes, report.outputBytes)}%).`
      : `None of the ${report.files.length} image${report.files.length === 1 ? '' : 's'} could be made meaningfully smaller.`,
  ]
  if (written.length) {
    lines.push('', '| Image | Before | After | Saved |', '|---|---:|---:|---:|')
    for (const file of written.slice(0, 100)) {
      lines.push(`| \`${posix(relative(workspace, file.path))}\` | ${formatBytes(file.inputSize)} | ${formatBytes(file.outputSize!)} | ${savedPercent(file.inputSize, file.outputSize!)}% |`)
    }
    if (written.length > 100) lines.push(`| … and ${written.length - 100} more | | | |`)
  }
  const unchanged = report.files.filter(file => file.status === 'unchanged').length
  const failed = report.files.filter(file => file.status === 'failed' || file.status === 'skipped')
  if (unchanged) lines.push('', `${unchanged} already optimized or below the minimum saving; left as they were.`)
  if (failed.length) lines.push('', `${failed.length} not compressed: ${failed.slice(0, 10).map(f => `\`${posix(relative(workspace, f.path))}\` (${f.error?.message})`).join(', ')}`)
  if (report.compressionCount !== undefined) lines.push('', `<sub>API compressions used this month: ${report.compressionCount}</sub>`)
  return lines.join('\n')
}

function git(workspace: string, ...args: string[]): string {
  return execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim()
}

function commit(workspace: string, files: FileReport[], message: string): void {
  const name = process.env.GITHUB_EVENT_NAME ?? ''
  let branch: string | undefined
  if (name.startsWith('pull_request')) {
    const event = readEvent<PullRequestEvent>()!
    if (event.pull_request.head.repo?.full_name !== event.repository.full_name) {
      log.warning('This pull request comes from a fork, so the action cannot push to it. The compressed images were not committed.')
      return
    }
    if (git(workspace, 'rev-parse', 'HEAD') !== event.pull_request.head.sha) {
      throw new Error('To commit to a pull request, check out its branch: actions/checkout with "ref: ${{ github.head_ref }}".')
    }
    branch = event.pull_request.head.ref
  } else if (process.env.GITHUB_REF?.startsWith('refs/heads/')) {
    branch = process.env.GITHUB_REF.slice('refs/heads/'.length)
  }
  if (!branch) {
    log.warning('Not on a branch, so the compressed images were not committed.')
    return
  }
  git(workspace, 'add', '--', ...files.map(file => relative(workspace, file.path)))
  git(workspace, '-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '--quiet', '-m', message)
  git(workspace, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`)
  log.info(`Committed ${files.length} compressed image${files.length === 1 ? '' : 's'} to ${branch}.`)
}

async function run(): Promise<void> {
  const apiKey = input('api-key')
  if (!apiKey) throw new Error('The api-key input is required. Add your Bitinz API key as a repository secret and pass it: api-key: ${{ secrets.BITINZ_API_KEY }}')
  log.mask(apiKey)
  const level = input('level') as Level | ''
  if (level && !['fast', 'default', 'best'].includes(level)) throw new Error('level must be fast, default or best')
  const minSavings = Number(input('min-savings', '2'))
  if (!Number.isFinite(minSavings) || minSavings < 0 || minSavings >= 100) throw new Error('min-savings must be a percentage from 0 to 99')
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd()
  const wanted = matcher(listInput('paths', DEFAULT_PATHS)), ignored = matcher(listInput('ignore'))

  const { files: listed, scope } = await candidates(workspace, booleanInput('changed-only', true), input('github-token'))
  const files = listed.filter(path => IMAGE.test(path) && wanted(path) && !ignored(path) && existsSync(join(workspace, path)) && statSync(join(workspace, path)).isFile())
  log.info(`${files.length} image${files.length === 1 ? '' : 's'} to compress (${scope}).`)
  if (!files.length) {
    setOutput('files', 0)
    setOutput('bytes-saved', 0)
    setOutput('markdown', '')
    appendSummary(`### Bitinz image compression\n\nNo images to compress (${scope}).`)
    return
  }

  const client = new Bitinz({ apiKey, baseUrl: process.env.BITINZ_BASE_URL || undefined })
  const report = await compressFiles(client, files.map(path => ({ path: join(workspace, path), root: workspace })), {
    inPlace: true, level: level || undefined, minSavings,
    onFile: file => {
      const path = posix(relative(workspace, file.path))
      if (file.status === 'compressed') log.info(`✓ ${path}  ${formatBytes(file.inputSize)} → ${formatBytes(file.outputSize!)}  −${savedPercent(file.inputSize, file.outputSize!)}%`)
      else if (file.status === 'unchanged') log.info(`= ${path}  unchanged`)
      else if (file.status === 'failed') log.warning(file.error?.message ?? 'could not be compressed', path)
    },
  })
  const written = report.files.filter(file => file.status === 'compressed')
  const markdown = table(report, workspace)
  setOutput('files', written.length)
  setOutput('bytes-saved', report.inputBytes - report.outputBytes)
  setOutput('markdown', markdown)
  appendSummary(markdown)
  if (report.stopped) throw new Error(`Stopped: ${report.stopped.message}`)
  if (written.length && booleanInput('commit', false)) commit(workspace, written, input('commit-message', 'Compress images with Bitinz'))
}

run().catch(error => {
  log.error((error as Error).message)
  process.exitCode = 1
})
