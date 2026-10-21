import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const rust = readFileSync(resolve('src-tauri/src/service/patch/chat_follow_anchor.rs'), 'utf8')
const fixturePath = resolve('test/fixtures/chat-follow-anchor.txt')
const fixture = readFileSync(fixturePath, 'utf8')

function anchor(name: string) {
  const original = rust.match(new RegExp(`const ORIGINAL_${name}: &str = r#"([\\s\\S]*?)"#;`))?.[1]
  const patched = rust.match(new RegExp(`const PATCHED_${name}: &str = r#"([\\s\\S]*?)"#;`))?.[1]
  if (!original || !patched)
    throw new Error(`Missing ${name} patch anchor`)
  return { original, patched }
}

const css = anchor('CSS')
const bind = anchor('BIND')
const follow = anchor('FOLLOW')
if (fixture.split(bind.original).length !== 2 || fixture.split(follow.original).length !== 2)
  throw new Error('Missing unique production follow-anchor patch')

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

describe('chat follow anchor patch', () => {
  it('drops the ancestor :has() and mirrors the same attribute from JavaScript', () => {
    expect(css.original).toContain(':has(.EvIC1a_root[data-chat-following-tail])')
    expect(css.patched).toBe('[data-conversation-scroll][data-chat-following-tail]')
    expect(css.patched).not.toContain(':has(')
    expect(bind.patched).toContain('this.followAnchor();')
    expect(follow.patched).toContain('scrollport.setAttribute("data-chat-following-tail", "")')
  })

  it('satisfies the shared contract with the production replacement', () => {
    directory = mkdtempSync(resolve('test/.chat-follow-anchor-'))
    const target = resolve(directory, 'client.txt')
    const patched = fixture.replace(bind.original, bind.patched).replace(follow.original, follow.patched)
    writeFileSync(target, patched)
    const result = runContract(target)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toMatch(/# fail 0\b/)
  })

  it('rejects the released source that never mirrors the follow intent', () => {
    const result = runContract(fixturePath)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stdout).toContain('not ok 1 - following mirrors the intent onto the enclosing scrollport')
    expect(result.stdout).toMatch(/# fail [1-9]\d*\b/)
  })
})
