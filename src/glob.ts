// Glob patterns for repository paths: **, *, ?, {a,b}. A pattern without
// wildcards names a file or a folder (and everything inside it).
export function globToRegExp(pattern: string): RegExp {
  const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '')
  if (!/[*?{]/.test(clean)) return new RegExp(`^${escape(clean)}(?:/.*)?$`)
  let source = ''
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i]
    if (char === '*' && clean[i + 1] === '*') {
      // "**/" matches any number of folders, including none; a trailing "**" anything.
      if (clean[i + 2] === '/') { source += '(?:.*/)?'; i += 2 } else { source += '.*'; i++ }
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else if (char === '{') {
      const end = clean.indexOf('}', i)
      if (end < 0) { source += '\\{'; continue }
      source += `(?:${clean.slice(i + 1, end).split(',').map(escape).join('|')})`
      i = end
    } else source += escape(char)
  }
  return new RegExp(`^${source}$`)
}

function escape(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

export function matcher(patterns: string[]): (path: string) => boolean {
  const expressions = patterns.map(globToRegExp)
  return path => expressions.some(expression => expression.test(path))
}
