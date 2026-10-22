import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { bytes, KEY, startMockApi } from './mock-api.mjs'

const ACTION = fileURLToPath(new URL('../dist/index.mjs', import.meta.url))
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

// A repository with a remote: images in public/ and docs/, and a vendored folder.
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'bitinz-action-'))
  const remote = join(root, 'remote.git'), work = join(root, 'work')
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote])
  execFileSync('git', ['clone', '--quiet', remote, work], { stdio: 'ignore' })
  await mkdir(join(work, 'public/img'), { recursive: true })
  await mkdir(join(work, 'docs'), { recursive: true })
  await writeFile(join(work, 'public/img/hero.jpg'), bytes.jpeg('h'.repeat(300)))
  await writeFile(join(work, 'public/img/logo.png'), bytes.png('l'.repeat(100)))
  await writeFile(join(work, 'docs/diagram.png'), bytes.png('d'.repeat(100)))
  await writeFile(join(work, 'public/img/done.png'), bytes.png('OPTIMIZED' + 'x'.repeat(50)))
  git(work, 'add', '.')
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'images')
  git(work, 'push', '--quiet', 'origin', 'HEAD:main')
  git(work, 'checkout', '--quiet', '-b', 'feature')
  git(work, 'push', '--quiet', 'origin', 'HEAD:feature')
  return { root, remote, work, head: git(work, 'rev-parse', 'HEAD') }
}

async function githubApi(files) {
  const server = createServer((req, res) => {
    const page = Number(new URL(req.url, 'http://x').searchParams.get('page') ?? 1)
    res.writeHead(req.headers.authorization === 'Bearer gh-token' ? 200 : 401, { 'content-type': 'application/json' })
    res.end(JSON.stringify(page === 1 ? files : []))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

async function action({ work, root }, inputs, { event, eventName = 'workflow_dispatch', env = {} } = {}) {
  const eventPath = join(root, 'event.json'), output = join(root, 'output.txt'), summary = join(root, 'summary.md')
  await writeFile(eventPath, JSON.stringify(event ?? {}))
  await writeFile(output, '')
  await writeFile(summary, '')
  const vars = Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, String(value)]))
  return new Promise(resolve => {
    const child = spawn(process.execPath, [ACTION], {
      cwd: work, env: {
        PATH: process.env.PATH, HOME: root, GITHUB_WORKSPACE: work, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: eventName,
        GITHUB_REPOSITORY: 'acme/site', GITHUB_REF: 'refs/heads/feature', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...vars, ...env,
      },
    })
    let stdout = ''
    child.stdout.on('data', d => stdout += d)
    child.stderr.on('data', d => stdout += d)
    child.on('close', async code => {
      const outputs = Object.fromEntries([...(await readFile(output, 'utf8')).matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)].map(m => [m[1], m[3]]))
      resolve({ code, stdout, outputs, summary: await readFile(summary, 'utf8') })
    })
  })
}

test('a manual run compresses every matching image in place and reports a summary', async t => {
  const api = await startMockApi()
  t.after(api.close)
  const repo = await repository()
  const result = await action(repo, { 'api-key': KEY, ignore: 'docs/**' }, { env: { BITINZ_BASE_URL: api.url } })
  assert.equal(result.code, 0, result.stdout)
  assert.match(result.stdout, /::add-mask::bz_a+/)
  assert.match(result.stdout, /3 images to compress \(in the repository\)/)
  assert.equal(result.outputs.files, '2')
  assert.equal(result.outputs['bytes-saved'], String(152 + 54))
  assert.match(result.summary, /Compressed \*\*2\*\* of 3 images/)
  assert.match(result.summary, /\| `public\/img\/hero\.jpg` \| 304 B \| 152 B \| 50% \|/)
  assert.match(result.summary, /1 already optimized/)
  assert.equal((await readFile(join(repo.work, 'public/img/hero.jpg'))).length, 152)
  assert.equal((await readFile(join(repo.work, 'docs/diagram.png'))).length, 108, 'ignored')
  assert.equal(git(repo.work, 'rev-parse', 'HEAD'), repo.head, 'nothing committed by default')
})

test('a pull request compresses only its changed images and commits them to its branch', async t => {
  const api = await startMockApi()
  t.after(api.close)
  const gh = await githubApi([{ filename: 'public/img/logo.png', status: 'modified' }, { filename: 'docs/diagram.png', status: 'added' }, { filename: 'gone.png', status: 'removed' }])
  t.after(gh.close)
  const repo = await repository()
  const event = { pull_request: { number: 7, head: { ref: 'feature', sha: repo.head, repo: { full_name: 'acme/site' } } }, repository: { full_name: 'acme/site' } }
  const result = await action(repo, { 'api-key': KEY, 'github-token': 'gh-token', commit: 'true', level: 'best' },
    { event, eventName: 'pull_request', env: { BITINZ_BASE_URL: api.url, GITHUB_API_URL: gh.url } })
  assert.equal(result.code, 0, result.stdout)
  assert.match(result.stdout, /2 images to compress \(changed in pull request #7\)/)
  assert.deepEqual(api.state.requests.filter(r => r.method === 'POST').map(r => r.query.filename).sort(), ['diagram.png', 'logo.png'])
  assert.ok(api.state.requests.filter(r => r.method === 'POST').every(r => r.query.level === 'best'))
  assert.equal(git(repo.remote, 'log', '-1', '--format=%s %an', 'feature'), 'Compress images with Bitinz github-actions[bot]')
  assert.equal(git(repo.remote, 'diff', '--name-only', 'feature~1', 'feature'), 'docs/diagram.png\npublic/img/logo.png')
  assert.equal(git(repo.remote, 'rev-parse', 'main'), repo.head, 'main is untouched')
})

test('pull requests from forks are compressed but not committed; a detached checkout is refused', async t => {
  const api = await startMockApi()
  t.after(api.close)
  const gh = await githubApi([{ filename: 'public/img/logo.png', status: 'modified' }])
  t.after(gh.close)
  const repo = await repository()
  const fork = { pull_request: { number: 8, head: { ref: 'feature', sha: repo.head, repo: { full_name: 'someone/site' } } }, repository: { full_name: 'acme/site' } }
  const env = { BITINZ_BASE_URL: api.url, GITHUB_API_URL: gh.url }
  const forked = await action(repo, { 'api-key': KEY, 'github-token': 'gh-token', commit: 'true' }, { event: fork, eventName: 'pull_request', env })
  assert.equal(forked.code, 0)
  assert.match(forked.stdout, /::warning::This pull request comes from a fork/)
  assert.equal(git(repo.remote, 'rev-parse', 'feature'), repo.head)

  await writeFile(join(repo.work, 'public/img/logo.png'), bytes.png('l'.repeat(100)))
  const merge = { pull_request: { number: 9, head: { ref: 'feature', sha: 'f'.repeat(40), repo: { full_name: 'acme/site' } } }, repository: { full_name: 'acme/site' } }
  const detached = await action(repo, { 'api-key': KEY, 'github-token': 'gh-token', commit: 'true' }, { event: merge, eventName: 'pull_request', env })
  assert.equal(detached.code, 1)
  assert.match(detached.stdout, /::error::To commit to a pull request, check out its branch/)
})

test('a used-up quota fails the step; a missing key explains how to add one', async t => {
  const api = await startMockApi({ quota: 0 })
  t.after(api.close)
  const repo = await repository()
  const quota = await action(repo, { 'api-key': KEY }, { env: { BITINZ_BASE_URL: api.url } })
  assert.equal(quota.code, 1)
  assert.match(quota.stdout, /::error::Stopped: monthly compression quota of 0 reached/)
  const missing = await action(repo, {})
  assert.equal(missing.code, 1)
  assert.match(missing.stdout, /::error::The api-key input is required/)
})
