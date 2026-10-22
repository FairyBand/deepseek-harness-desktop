import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const rust = readFileSync(resolve('src-tauri/src/service/patch/chat_follow_anchor.rs'), 'utf8')
const fixturePath = resolve('test/fixtures/chat-follow-anchor.txt')
const fixture = readFileSync(fixturePath, 'utf8')

function constString(name: string) {
  const value = rust.match(new RegExp(`const ${name}: &str\\s*=\\s*r#"([\\s\\S]*?)"#;`))?.[1]
  if (!value)
    throw new Error(`Missing ${name} patch anchor`)
  return value
}

function anchor(name: string) {
  return { original: constString(`ORIGINAL_${name}`), patched: constString(`PATCHED_${name}`) }
}

const css = anchor('CSS')
const stat = anchor('STATIC')
const bind = anchor('BIND')
const follow = anchor('FOLLOW')
const legacyBind = constString('LEGACY_BIND')
const legacyFollow = constString('LEGACY_FOLLOW')

for (const original of [stat.original, bind.original, follow.original]) {
  if (fixture.split(original).length !== 2)
    throw new Error('Missing unique production follow-anchor patch')
}

let directory: string | undefined

afterEach(() => {
  if (directory)
    rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function runContract(path: string) {
  return spawnSync(
    process.execPath,
    ['--test-reporter=tap', resolve('test/fixtures/chat-follow-anchor-contract.mjs'), path],
    { encoding: 'utf8', timeout: 20000 },
  )
}

function patchedFixture() {
  return fixture
    .replace(stat.original, stat.patched)
    .replace(bind.original, bind.patched)
    .replace(follow.original, follow.patched)
}

function writeTemporary(source: string) {
  directory = mkdtempSync(resolve('test/.chat-follow-anchor-'))
  const target = resolve(directory, 'client.txt')
  writeFileSync(target, source)
  return target
}

describe('chat follow anchor patch', () => {
  it('drops the ancestor :has() and mirrors the same attribute from JavaScript', () => {
    expect(css.original).toContain(':has(.EvIC1a_root[data-chat-following-tail])')
    expect(css.patched).toBe('[data-conversation-scroll][data-chat-following-tail]')
    expect(css.patched).not.toContain(':has(')
    expect(stat.patched).toContain('static followers = /* @__PURE__ */ new WeakMap();')
    expect(bind.patched).toContain('this.followAnchor();')
    expect(bind.patched).toContain('ScrollFollow.followers.get(scrollport)')
    expect(follow.patched).not.toContain('ScrollFollow.owners.forEach')
    expect(follow.patched).toContain('ScrollFollow.followers.get(scrollport)')
    expect(follow.patched).toContain('scrollport.setAttribute("data-chat-following-tail", "")')
  })

  it('satisfies the shared contract with the production replacement', () => {
    const result = runContract(writeTemporary(patchedFixture()))
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toMatch(/# fail 0\b/)
  })

  it('reproduces the shipped WeakMap crash for the legacy replacement', () => {
    const legacy = fixture.replace(bind.original, legacyBind).replace(follow.original, legacyFollow)
    const result = runContract(writeTemporary(legacy))
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stdout).toContain('ScrollFollow.owners.forEach is not a function')
  })

  it('rejects the released source that never mirrors the follow intent', () => {
    const result = runContract(fixturePath)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stdout).toContain('not ok 1 - following mirrors the intent onto the enclosing scrollport')
    expect(result.stdout).toMatch(/# fail [1-9]\d*\b/)
  })
})
