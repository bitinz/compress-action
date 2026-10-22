// The small part of the Actions toolkit this action needs, without dependencies:
// inputs, outputs, the job summary, log annotations and the REST API.
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

export function input(name: string, fallback = ''): string {
  return (process.env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`] ?? '').trim() || fallback
}

export function booleanInput(name: string, fallback: boolean): boolean {
  const value = input(name).toLowerCase()
  if (!value) return fallback
  if (['true', 'yes', '1'].includes(value)) return true
  if (['false', 'no', '0'].includes(value)) return false
  throw new Error(`Input "${name}" must be true or false, not "${value}"`)
}

/** Newline- or comma-separated values. */
export function listInput(name: string, fallback: string[] = []): string[] {
  const values = input(name).split(/[\n,]/).map(value => value.trim()).filter(Boolean)
  return values.length ? values : fallback
}

const escape = (value: string) => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
export const log = {
  info: (message: string) => console.log(message),
  notice: (message: string) => console.log(`::notice::${escape(message)}`),
  warning: (message: string, file?: string) => console.log(`::warning${file ? ` file=${file}` : ''}::${escape(message)}`),
  error: (message: string) => console.log(`::error::${escape(message)}`),
  mask: (secret: string) => console.log(`::add-mask::${secret}`),
}

export function setOutput(name: string, value: string | number): void {
  const file = process.env.GITHUB_OUTPUT
  if (!file) return
  const delimiter = `bitinz_${randomUUID()}`
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
}

export function appendSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (file) appendFileSync(file, markdown + '\n')
}

export interface PullRequestEvent {
  number: number
  pull_request: { number: number; head: { ref: string; sha: string; repo: { full_name: string } | null } }
  repository: { full_name: string }
}

export interface PushEvent {
  before: string
  after: string
  repository: { full_name: string }
}

export function readEvent<T>(): T | undefined {
  const path = process.env.GITHUB_EVENT_PATH
  return path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : undefined
}

async function api<T>(path: string, token: string): Promise<T> {
  const base = process.env.GITHUB_API_URL ?? 'https://api.github.com'
  const response = await fetch(base + path, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'bitinz-compress-action' },
  })
  if (!response.ok) throw new Error(`GitHub API ${path}: HTTP ${response.status}`)
  return response.json() as Promise<T>
}

type ChangedFile = { filename: string; status: string }

/** Files a pull request adds or changes (the API lists up to 3000). */
export async function pullRequestFiles(repo: string, number: number, token: string): Promise<string[]> {
  const files: string[] = []
  for (let page = 1; ; page++) {
    const batch = await api<ChangedFile[]>(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, token)
    files.push(...batch.filter(file => file.status !== 'removed').map(file => file.filename))
    if (batch.length < 100) return files
  }
}

/** Files a push adds or changes, or undefined when the comparison is incomplete (over 300 files). */
export async function pushedFiles(repo: string, before: string, after: string, token: string): Promise<string[] | undefined> {
  const { files = [] } = await api<{ files?: ChangedFile[] }>(`/repos/${repo}/compare/${before}...${after}`, token)
  return files.length >= 300 ? undefined : files.filter(file => file.status !== 'removed').map(file => file.filename)
}
