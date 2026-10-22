import assert from 'node:assert/strict'
import test from 'node:test'
import { matcher } from '../src/glob.ts'

test('glob patterns match repository paths', () => {
  const images = matcher(['**/*.{png,jpg,jpeg,webp}'])
  for (const path of ['a.png', 'public/img/hero.jpg', 'x/y/z.webp']) assert.ok(images(path), path)
  for (const path of ['a.gif', 'png', 'public/img/hero.jpg.bak']) assert.ok(!images(path), path)
  const folder = matcher(['public', './docs/'])
  assert.ok(folder('public/a.png') && folder('docs/x/y.png') && folder('public'))
  assert.ok(!folder('publicity/a.png'))
  const one = matcher(['assets/*.png', 'icons/icon-?.png'])
  assert.ok(one('assets/a.png') && one('icons/icon-1.png'))
  assert.ok(!one('assets/sub/a.png') && !one('icons/icon-10.png'))
})
